/* tslint:disable:variable-name */
//
// Modified version of this https://github.com/daypaio/nestjs-eventstore/blob/master/src/event-store/eventstore-cqrs/event-store.bus.ts
// special thanks to him.
//

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { IEvent, IEventPublisher, EventBus, CommandBus, QueryBus, IMessageSource } from '@nestjs/cqrs';
import { ExplorerService } from '@nestjs/cqrs/dist/services/explorer.service';
import { Subject } from 'rxjs';
import { v4 } from 'uuid';
import {
  EventData,
  EventStorePersistentSubscription,
  ResolvedEvent,
  EventStoreCatchUpSubscription,
  expectedVersion,
  createJsonEventData,
} from 'node-eventstore-client';
import {
  EventStoreOptionConfig,
  IEventConstructors,
  EventStoreSubscriptionType,
  EventStorePersistentSubscription as ESPersistentSubscription,
  EventStoreCatchupSubscription as ESCatchUpSubscription, ExtendedCatchUpSubscription, ExtendedPersistentSubscription
} from './contract/event-store-option.config';
import { NestjsEventStore } from './nestjs-event-store.class';
import { ProvidersConstants } from './contract/nestjs-event-store.constant';
import { IEventStoreConnectConfig } from './contract/event-store-connect-config.interface';

/**
 * @class EventStore
 */
@Injectable()
export class EventStore implements IEventPublisher, OnModuleDestroy, OnModuleInit, IMessageSource {
  private logger = new Logger(this.constructor.name);
  private eventStore: NestjsEventStore;
  private eventHandlers: IEventConstructors;
  private catchupSubscriptions: ExtendedCatchUpSubscription[] = [];
  private catchupSubscriptionsCount: number;
  private subject$: Subject<IEvent>;

  private persistentSubscriptions: ExtendedPersistentSubscription[] = [];
  private persistentSubscriptionsCount: number;
  private readonly featureStream?: string;

  constructor(
    @Inject(ProvidersConstants.EVENT_STORE_PROVIDER) eventStore: any,
    @Inject(ProvidersConstants.EVENT_STORE_CONNECTION_CONFIG_PROVIDER) configService: IEventStoreConnectConfig,
    @Inject(ProvidersConstants.EVENT_STORE_STREAM_CONFIG_PROVIDER) esStreamConfig: EventStoreOptionConfig,
    private readonly explorerService: ExplorerService,
    private readonly eventsBus: EventBus,
    private readonly commandsBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {

    this.eventStore = eventStore;
    this.featureStream = esStreamConfig.featureStreamName;
    this.addEventHandlers(esStreamConfig.eventHandlers);
    this.eventStore.connect(configService.options, configService.tcpEndpoint);

    const catchupSubscriptions = esStreamConfig.subscriptions.filter((sub) => {
      return sub.type === EventStoreSubscriptionType.CatchUp;
    });

    const persistentSubscriptions = esStreamConfig.subscriptions.filter((sub) => {
      return sub.type === EventStoreSubscriptionType.Persistent;
    });

    this.subscribeToCatchUpSubscriptions(
      catchupSubscriptions as ESCatchUpSubscription[],
    );

    this.subscribeToPersistentSubscriptions(
      persistentSubscriptions as ESPersistentSubscription[],
    );
  }

  async publish(event: IEvent, stream?: string) {
    if (event === undefined) { return; }
    if (event === null) { return; }

    const eventPayload: EventData = createJsonEventData(
      v4(),
      event,
      null,
      stream,
    );

    const streamId = stream ? stream : this.featureStream;

    try {
      await this.eventStore.getConnection().appendToStream(streamId, expectedVersion.any, [eventPayload]);
    } catch (err) {
      this.logger.error(err);
    }
  }

  async subscribeToPersistentSubscriptions(
    subscriptions: ESPersistentSubscription[],
  ) {
    this.persistentSubscriptionsCount = subscriptions.length;
    this.persistentSubscriptions = await Promise.all(
      subscriptions.map(async (subscription) => {
        return await this.subscribeToPersistentSubscription(
          subscription.stream,
          subscription.persistentSubscriptionName,
        );
      }),
    );
  }

  subscribeToCatchUpSubscriptions(subscriptions: ESCatchUpSubscription[]) {
    this.catchupSubscriptionsCount = subscriptions.length;
    this.catchupSubscriptions = subscriptions.map((subscription) => {
      return this.subscribeToCatchupSubscription(subscription.stream);
    });
  }

  subscribeToCatchupSubscription(stream: string): ExtendedCatchUpSubscription {
    this.logger.log(`Catching up and subscribing to stream ${stream}!`);
    try {
      return this.eventStore.getConnection().subscribeToStreamFrom(
        stream,
        0,
        true,
        (sub, payload) => this.onEvent(sub, payload),
        subscription =>
          this.onLiveProcessingStarted(
            subscription as ExtendedCatchUpSubscription,
          ),
        (sub, reason, error) =>
          this.onDropped(sub as ExtendedCatchUpSubscription, reason, error),
      ) as ExtendedCatchUpSubscription;
    } catch (err) {
      this.logger.error(err.message);
    }
  }

  get allCatchUpSubscriptionsLive(): boolean {
    const initialized =
      this.catchupSubscriptions.length === this.catchupSubscriptionsCount;
    return (
      initialized &&
      this.catchupSubscriptions.every((subscription) => {
        return !!subscription && subscription.isLive;
      })
    );
  }

  get allPersistentSubscriptionsLive(): boolean {
    const initialized =
      this.persistentSubscriptions.length === this.persistentSubscriptionsCount;
    return (
      initialized &&
      this.persistentSubscriptions.every((subscription) => {
        return !!subscription && subscription.isLive;
      })
    );
  }

  async subscribeToPersistentSubscription(
    stream: string,
    subscriptionName: string,
  ): Promise<ExtendedPersistentSubscription> {
    try {
      this.logger.log(`
       Connecting to persistent subscription ${subscriptionName} on stream ${stream}!
      `);

      const resolved: ExtendedPersistentSubscription = await this.eventStore.getConnection().connectToPersistentSubscription(
        stream,
        subscriptionName,
        (sub, payload) => this.onEvent(sub, payload),
        (sub, reason, error) =>
          this.onDropped(sub as ExtendedPersistentSubscription, reason, error),
      );

      resolved.isLive = true;

      return resolved;
    } catch (err) {
      this.logger.error(err.message);
    }
  }

  async onEvent(
    _subscription:
      | EventStorePersistentSubscription
      | EventStoreCatchUpSubscription,
    payload: ResolvedEvent,
  ) {
    const { event } = payload;

    if (!event || !event.isJson) {
      this.logger.error('Received event that could not be resolved!');
      return;
    }

    const handler = this.eventHandlers[event.eventType];
    if (!handler) {
      this.logger.error('Received event that could not be handled!');
      return;
    }

    const rawData = JSON.parse(event.data.toString());
    const data = Object.values(rawData);

    const eventType = event.eventType || rawData.content.eventType;
    if (this.eventHandlers && this.eventHandlers[eventType]) {
      this.subject$.next(this.eventHandlers[event.eventType](...data));
    } else {
      Logger.warn(`Event of type ${eventType} not handled`, this.constructor.name)
    }
  }

  onDropped(
    subscription: ExtendedPersistentSubscription | ExtendedCatchUpSubscription,
    _reason: string,
    error: Error,
  ) {
    subscription.isLive = false;
    this.logger.error(error);
  }

  onLiveProcessingStarted(subscription: ExtendedCatchUpSubscription) {
    subscription.isLive = true;
    this.logger.log('Live processing of EventStore events started!');
  }

  get isLive(): boolean {
    return (
      this.allCatchUpSubscriptionsLive && this.allPersistentSubscriptionsLive
    );
  }

  addEventHandlers(eventHandlers: IEventConstructors) {
    this.eventHandlers = { ...this.eventHandlers, ...eventHandlers };
  }
  onModuleInit(): any {
    const { events, queries, sagas, commands } = this.explorerService.explore();

    this.eventsBus.register(events);
    this.commandsBus.register(commands);
    this.queryBus.register(queries);
    this.eventsBus.registerSagas(sagas);

    this.subject$ = (this.eventsBus as any).subject$;
    this.bridgeEventsTo((this.eventsBus as any).subject$);
    this.eventsBus.publisher = this
  }

  onModuleDestroy(): any {
    this.eventStore.close();
  }

  async bridgeEventsTo<T extends IEvent>(subject: Subject<T>): Promise<any> {
    this.subject$ = subject;
  }

}
