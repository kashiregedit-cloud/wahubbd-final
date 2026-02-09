import {
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AppsService,
  IAppsService,
} from '@waha/apps/app_sdk/services/IAppsService';
import { EngineBootstrap } from '@waha/core/abc/EngineBootstrap';
import { GowsEngineConfigService } from '@waha/core/config/GowsEngineConfigService';
import { WebJSEngineConfigService } from '@waha/core/config/WebJSEngineConfigService';
import { WhatsappSessionGoWSCore } from '@waha/core/engines/gows/session.gows.core';
import { WebhookConductor } from '@waha/core/integrations/webhooks/WebhookConductor';
import { MediaStorageFactory } from '@waha/core/media/MediaStorageFactory';
import { DefaultMap } from '@waha/utils/DefaultMap';
import { getPinoLogLevel, LoggerBuilder } from '@waha/utils/logging';
import { promiseTimeout, sleep } from '@waha/utils/promiseTimeout';
import { complete } from '@waha/utils/reactive/complete';
import { SwitchObservable } from '@waha/utils/reactive/SwitchObservable';
import { PinoLogger } from 'nestjs-pino';
import { EMPTY, Observable, retry, share } from 'rxjs';
import { map } from 'rxjs/operators';

import { WhatsappConfigService } from '../config.service';
import {
  WAHAEngine,
  WAHAEvents,
  WAHASessionStatus,
} from '../structures/enums.dto';
import {
  ProxyConfig,
  SessionConfig,
  SessionDetailedInfo,
  SessionDTO,
  SessionInfo,
} from '../structures/sessions.dto';
import { WebhookConfig } from '../structures/webhooks.config.dto';
import { populateSessionInfo, SessionManager } from './abc/manager.abc';
import { SessionParams, WhatsappSession } from './abc/session.abc';
import { EngineConfigService } from './config/EngineConfigService';
import { WhatsappSessionNoWebCore } from './engines/noweb/session.noweb.core';
import { WhatsappSessionWebJSCore } from './engines/webjs/session.webjs.core';
import { DOCS_URL } from './exceptions';
import { getProxyConfig } from './helpers.proxy';
import { MediaManager } from './media/MediaManager';
import { LocalSessionAuthRepository } from './storage/LocalSessionAuthRepository';
import { LocalStoreCore } from './storage/LocalStoreCore';

export class OnlyDefaultSessionIsAllowed extends UnprocessableEntityException {}

enum DefaultSessionStatus {
  REMOVED = undefined,
  STOPPED = null,
}

@Injectable()
export class SessionManagerCore extends SessionManager implements OnModuleInit {
  SESSION_STOP_TIMEOUT = 3000;

  // session - exists and running (or failed or smth)
  // null - stopped
  // undefined - removed
  private sessions: Map<string, WhatsappSession | DefaultSessionStatus> = new Map();
  private sessionConfigs: Map<string, SessionConfig> = new Map();
  DEFAULT = 'default';

  protected readonly EngineClass: typeof WhatsappSession;
  private eventsMap: Map<string, DefaultMap<WAHAEvents, SwitchObservable<any>>> = new Map();
  protected readonly engineBootstrap: EngineBootstrap;

  constructor(
    config: WhatsappConfigService,
    private engineConfigService: EngineConfigService,
    private webjsEngineConfigService: WebJSEngineConfigService,
    gowsConfigService: GowsEngineConfigService,
    log: PinoLogger,
    private mediaStorageFactory: MediaStorageFactory,
    @Inject(AppsService)
    appsService: IAppsService,
  ) {
    super(log, config, gowsConfigService, appsService);
    this.sessions.set(this.DEFAULT, DefaultSessionStatus.STOPPED);
    const engineName = this.engineConfigService.getDefaultEngineName();
    this.EngineClass = this.getEngine(engineName);
    this.engineBootstrap = this.getEngineBootstrap(engineName);

    this.eventsMap.set(
      this.DEFAULT,
      new DefaultMap<WAHAEvents, SwitchObservable<any>>((key) =>
        new SwitchObservable((obs$) => {
          return obs$.pipe(retry(), share());
        }),
      ),
    );

    this.store = new LocalStoreCore(engineName.toLowerCase());
    this.sessionAuthRepository = new LocalSessionAuthRepository(this.store);
    this.clearStorage().catch((error) => {
      this.log.error({ error }, 'Error while clearing storage');
    });
  }

  protected getEngine(engine: WAHAEngine): typeof WhatsappSession {
    if (engine === WAHAEngine.WEBJS) {
      return WhatsappSessionWebJSCore;
    } else if (engine === WAHAEngine.NOWEB) {
      return WhatsappSessionNoWebCore;
    } else if (engine === WAHAEngine.GOWS) {
      return WhatsappSessionGoWSCore;
    } else {
      throw new NotFoundException(`Unknown whatsapp engine '${engine}'.`);
    }
  }

  private onlyDefault(name: string) {}

  async beforeApplicationShutdown(signal?: string) {
    for (const name of Array.from(this.sessions.keys())) {
      if (this.isRunning(name)) {
        await this.stop(name, true);
      }
    }
    this.stopEvents();
    await this.engineBootstrap.shutdown();
  }

  async onApplicationBootstrap() {
    await this.engineBootstrap.bootstrap();
    this.startPredefinedSessions();
  }

  private async clearStorage() {
    const storage = await this.mediaStorageFactory.build(
      'all',
      this.log.logger.child({ name: 'Storage' }),
    );
    await storage.purge();
  }

  //
  // API Methods
  //
  async exists(name: string): Promise<boolean> {
    const state = this.sessions.get(name);
    return (
      (state !== undefined && state !== DefaultSessionStatus.REMOVED) ||
      this.sessionConfigs.has(name)
    );
  }

  isRunning(name: string): boolean {
    const state = this.sessions.get(name);
    if (!state) {
      return false;
    }
    const session = state as WhatsappSession;
    return session.status !== WAHASessionStatus.FAILED;
  }

  async upsert(name: string, config?: SessionConfig): Promise<void> {
    if (config) {
      this.sessionConfigs.set(name, config);
    }
  }

  async start(name: string): Promise<SessionDTO> {
    if (this.isRunning(name)) {
      throw new UnprocessableEntityException(
        `Session '${name}' is already started.`,
      );
    }
    this.log.info({ session: name }, `Starting session...`);
    const logger = this.log.logger.child({ session: name });
    const cfg = this.sessionConfigs.get(name);
    logger.level = getPinoLogLevel(cfg?.debug);
    const loggerBuilder: LoggerBuilder = logger;

    const storage = await this.mediaStorageFactory.build(
      name,
      loggerBuilder.child({ name: 'Storage' }),
    );
    await storage.init();
    const mediaManager = new MediaManager(
      storage,
      this.config.mimetypes,
      loggerBuilder.child({ name: 'MediaManager' }),
    );

    const webhook = new WebhookConductor(loggerBuilder);
    const proxyConfig = this.getProxyConfig(name);
    const sessionConfig: SessionParams = {
      name,
      mediaManager,
      loggerBuilder,
      printQR: this.engineConfigService.shouldPrintQR,
      sessionStore: this.store,
      proxyConfig: proxyConfig,
      sessionConfig: cfg,
      ignore: this.ignoreChatsConfig(cfg),
    };

    let EngineClass = this.EngineClass;
    if (cfg?.engine) {
      EngineClass = this.getEngine(cfg.engine);
    }

    if (EngineClass === WhatsappSessionWebJSCore) {
      sessionConfig.engineConfig = this.webjsEngineConfigService.getConfig();
    } else if (EngineClass === WhatsappSessionGoWSCore) {
      sessionConfig.engineConfig = this.gowsConfigService.getConfig();
    }
    await this.sessionAuthRepository.init(name);
    // @ts-ignore
    const session = new EngineClass(sessionConfig);
    this.sessions.set(name, session);
    this.updateSessionEvents(name);

    // configure webhooks
    const webhooks = this.getWebhooks(name);
    webhook.configure(session, webhooks);

    // Apps
    await this.appsService.beforeSessionStart(session, this.store);

    // start session
    await session.start();
    logger.info('Session has been started.');
    await this.appsService.afterSessionStart(session, this.store);

    return {
      name: session.name,
      status: session.status,
      config: session.sessionConfig,
    };
  }

  private updateSessionEvents(name: string) {
    const current = this.sessions.get(name);
    const events = this.eventsMap.get(name);
    if (
      !current ||
      current === DefaultSessionStatus.STOPPED ||
      current === DefaultSessionStatus.REMOVED
    ) {
      if (events) {
        for (const obs of events.values()) {
          obs.switch(EMPTY);
        }
      }
      return;
    }
    const session: WhatsappSession = current as WhatsappSession;
    if (!events) {
      // Logic below handles creation of events map if it doesn't exist
    }
    let sessionEvents = events;
    if (!sessionEvents) {
      sessionEvents = new DefaultMap<WAHAEvents, SwitchObservable<any>>((key) =>
        new SwitchObservable((obs$) => {
          return obs$.pipe(retry(), share());
        }),
      );
      this.eventsMap.set(name, sessionEvents);
    }
    for (const eventName in WAHAEvents) {
      const event = WAHAEvents[eventName];
      const stream$ = session
        .getEventObservable(event)
        .pipe(map(populateSessionInfo(event, session)));
      sessionEvents.get(event).switch(stream$);
    }
  }

  getSessionEvent(session: string, event: WAHAEvents): Observable<any> {
    const events = this.eventsMap.get(session);
    if (!events) {
      const created = new DefaultMap<WAHAEvents, SwitchObservable<any>>((key) =>
        new SwitchObservable((obs$) => {
          return obs$.pipe(retry(), share());
        }),
      );
      this.eventsMap.set(session, created);
      return created.get(event);
    }
    return events.get(event);
  }

  async stop(name: string, silent: boolean): Promise<void> {
    if (!this.isRunning(name)) {
      this.log.debug({ session: name }, `Session is not running.`);
      return;
    }

    this.log.info({ session: name }, `Stopping session...`);
    try {
      const session = this.getSession(name);
      await session.stop();
    } catch (err) {
      this.log.warn(`Error while stopping session '${name}'`);
      if (!silent) {
        throw err;
      }
    }
    this.log.info({ session: name }, `Session has been stopped.`);
    this.sessions.set(name, DefaultSessionStatus.STOPPED);
    this.updateSessionEvents(name);
    await sleep(this.SESSION_STOP_TIMEOUT);
  }

  async unpair(name: string) {
    const current = this.sessions.get(name);
    if (!current || current === DefaultSessionStatus.STOPPED || current === DefaultSessionStatus.REMOVED) {
      return;
    }
    const session = current as WhatsappSession;

    this.log.info({ session: name }, 'Unpairing the device from account...');
    await session.unpair().catch((err) => {
      this.log.warn(`Error while unpairing from device: ${err}`);
    });
    await sleep(1000);
  }

  async logout(name: string): Promise<void> {
    await this.sessionAuthRepository.clean(name);
  }

  async delete(name: string): Promise<void> {
    if (this.isRunning(name)) {
      await this.stop(name, true);
    }
    await this.sessionAuthRepository.clean(name);
    this.sessionConfigs.delete(name);
    this.sessions.delete(name);
    this.updateSessionEvents(name);
    this.eventsMap.delete(name);
  }

  /**
   * Combine per session and global webhooks
   */
  private getWebhooks(name: string) {
    let webhooks: WebhookConfig[] = [];
    const cfg = this.sessionConfigs.get(name);
    if (cfg?.webhooks) {
      webhooks = webhooks.concat(cfg.webhooks);
    }
    const globalWebhookConfig = this.config.getWebhookConfig();
    if (globalWebhookConfig) {
      webhooks.push(globalWebhookConfig);
    }
    return webhooks;
  }

  /**
   * Get either session's or global proxy if defined
   */
  protected getProxyConfig(name: string): ProxyConfig | undefined {
    const cfg = this.sessionConfigs.get(name);
    if (cfg?.proxy) {
      return cfg.proxy;
    }
    const current = this.sessions.get(name);
    if (!current || current === DefaultSessionStatus.STOPPED || current === DefaultSessionStatus.REMOVED) {
      return undefined;
    }
    const sessionsObj: Record<string, WhatsappSession> = {};
    this.sessions.forEach((value, key) => {
      if (value && value !== DefaultSessionStatus.STOPPED && value !== DefaultSessionStatus.REMOVED) {
        sessionsObj[key] = value as WhatsappSession;
      }
    });
    return getProxyConfig(this.config, sessionsObj, name);
  }

  getSession(name: string): WhatsappSession {
    const current = this.sessions.get(name);
    if (!current || current === DefaultSessionStatus.STOPPED || current === DefaultSessionStatus.REMOVED) {
      throw new NotFoundException(
        `We didn't find a session with name '${name}'.\n` +
          `Please start it first by using POST /api/sessions/${name}/start request`,
      );
    }
    return current as WhatsappSession;
  }

  async getSessions(all: boolean): Promise<SessionInfo[]> {
    const names = new Set<string>([
      ...Array.from(this.sessions.keys()),
      ...Array.from(this.sessionConfigs.keys()),
    ]);
    const result: SessionInfo[] = [];
    for (const name of names) {
      const state = this.sessions.get(name);
      const cfg = this.sessionConfigs.get(name);
      if (!state) {
        if (!all) continue;
        result.push({
          name,
          status: WAHASessionStatus.STOPPED,
          config: cfg,
          me: null,
          presence: null,
          timestamps: { activity: null },
        });
        continue;
      }
      if (state === DefaultSessionStatus.REMOVED) {
        if (all) {
          // skip removed
        }
        continue;
      }
      if (state === DefaultSessionStatus.STOPPED) {
        if (!all) continue;
        result.push({
          name,
          status: WAHASessionStatus.STOPPED,
          config: cfg,
          me: null,
          presence: null,
          timestamps: { activity: null },
        });
        continue;
      }
      const session = state as WhatsappSession;
      const me = session?.getSessionMeInfo();
      result.push({
        name: session.name,
        status: session.status,
        config: session.sessionConfig,
        me: me,
        presence: session.presence,
        timestamps: { activity: session?.getLastActivityTimestamp() },
      });
    }
    return result;
  }

  private async fetchEngineInfo(name: string) {
    const current = this.sessions.get(name) as WhatsappSession;
    // Get engine info
    let engineInfo = {};
    if (current) {
      try {
        engineInfo = await promiseTimeout(1000, current.getEngineInfo());
      } catch (error) {
        this.log.debug(
          { session: name, error: `${error}` },
          'Can not get engine info',
        );
      }
    }
    const engine = {
      engine: current?.engine,
      ...engineInfo,
    };
    return engine;
  }

  async getSessionInfo(name: string): Promise<SessionDetailedInfo | null> {
    const sessions = await this.getSessions(true);
    const info = sessions.find((s) => s.name === name);
    if (!info) {
      return null;
    }
    const engine = await this.fetchEngineInfo(name);
    return { ...info, engine };
  }

  protected stopEvents() {
    this.eventsMap.forEach((events) => complete(events));
  }

  async onModuleInit() {
    await this.init();
  }

  async init() {
    await this.store.init();
    const knex = this.store.getWAHADatabase();
    await this.appsService.migrate(knex);
  }
}
