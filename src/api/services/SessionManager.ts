// services/SessionManager.ts - Gerenciador de sessões e autenticação usando Prisma

import { Logger } from '../../utils/Logger';
import { InstanceConfig } from './InstanceManager';
import { prisma } from '../../database/PrismaClient';
import { BufferJSON } from '../../utils/BufferJSON';

/**
 * Interface para estado de autenticação
 */
export interface AuthState {
  creds?: {
    noiseKey?: Buffer;
    signedIdentityKey?: Buffer;
    signedPreKey?: Buffer;
    identityKey?: Buffer;
    registrationId?: number;
    advSecretKey?: string;
    nextPreKeyId?: number;
    firstUnuploadedPreKeyId?: number;
    serverHasPreKeys?: boolean;
  };
  keys?: {
    preKeys?: { [keyId: number]: Buffer };
    sessions?: { [jid: string]: any };
    senderKeys?: { [groupId: string]: { [senderKeyId: string]: Buffer } };
    appStateSyncKeys?: { [keyId: string]: any };
    appStateVersions?: { [name: string]: number };
  };
  deviceId?: string;
  phoneNumber?: string;
  profileName?: string;
  platform?: string;
  lastAccountSyncTimestamp?: number;
}

/**
 * Interface para dados de sessão
 */
export interface SessionData {
  instanceId: string;
  authState: AuthState;
  createdAt: Date;
  updatedAt: Date;
  lastAccess: Date;
}

/**
 * Gerenciador de sessões usando Prisma
 * Responsável por salvar e carregar estados de autenticação no banco de dados
 */
export class SessionManager {
  private static instance: SessionManager;
  private sessionCache: Map<string, SessionData> = new Map();
  private configCache: Map<string, InstanceConfig> = new Map();

  private constructor() {
    Logger.info('💾 SessionManager inicializado com Prisma');
  }

  /**
   * Verifica se as credenciais são válidas e completas
   */
  private hasValidCredentials(creds?: AuthState['creds']): boolean {
    if (!creds) return false;
    
    // Verifica se tem as chaves essenciais para uma conexão válida
    return !!(
      creds.noiseKey &&
      creds.signedIdentityKey &&
      creds.signedPreKey &&
      creds.identityKey &&
      creds.registrationId
    );
  }

  /**
   * Obtém a instância singleton
   */
  public static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  /**
   * Salva configuração de instância no banco
   */
  public async saveInstanceConfig(instanceId: string, config: InstanceConfig): Promise<void> {
    try {
      const configData = {
        ...config,
        updatedAt: new Date()
      };
      
      await prisma.instance.upsert({
        where: { instanceId },
        update: {
          nameDevice: config.name || `BZap-${instanceId}`,
          webhookUrl: config.webhookUrl || null
        },
        create: {
          id: instanceId,
          instanceId,
          nameDevice: config.name || `BZap-${instanceId}`,
          numberDevice: null,
          webhookUrl: config.webhookUrl || null,
          events: ['messages', 'connection'],
          status: 'disconnected'
        }
      });
      
      // Atualiza cache
      this.configCache.set(instanceId, config);
      
      Logger.info(`💾 Configuração salva no banco para instância: ${instanceId}`);
      
    } catch (error) {
      Logger.error(`❌ Erro ao salvar configuração da instância ${instanceId}:`, error);
      throw error;
    }
  }

  /**
   * Carrega configuração de instância do banco
   */
  public async getInstanceConfig(instanceId: string): Promise<InstanceConfig | null> {
    try {
      // Verifica cache primeiro
      if (this.configCache.has(instanceId)) {
        return this.configCache.get(instanceId)!;
      }
      
      const instance = await prisma.instance.findUnique({
        where: { instanceId },
        select: {
          instanceId: true,
          nameDevice: true,
          webhookUrl: true
        }
      });
      
      if (!instance) {
        return null;
      }
      
      const config: InstanceConfig = {
        id: instance.instanceId,
        name: instance.nameDevice || `BZap-${instance.instanceId}`,
        webhookUrl: instance.webhookUrl || undefined
      };
      
      // Atualiza cache
      this.configCache.set(instanceId, config);
      
      return config;
      
    } catch (error) {
      Logger.error(`❌ Erro ao carregar configuração da instância ${instanceId}:`, error);
      return null;
    }
  }

  /**
   * Obtém todas as configurações de instâncias do banco
   */
  public async getAllInstanceConfigs(): Promise<InstanceConfig[]> {
    try {
      const instances = await prisma.instance.findMany({
        select: {
          instanceId: true,
          nameDevice: true,
          webhookUrl: true
        }
      });
      
      const configs: InstanceConfig[] = instances.map(instance => ({
        id: instance.instanceId,
        name: instance.nameDevice || `BZap-${instance.instanceId}`,
        webhookUrl: instance.webhookUrl || undefined
      }));
      
      // Atualiza cache
      configs.forEach(config => {
        this.configCache.set(config.id, config);
      });
      
      return configs;
      
    } catch (error) {
      Logger.error('❌ Erro ao carregar todas as configurações:', error);
      return [];
    }
  }

  /**
   * Salva estado de autenticação no banco
   */
  public async saveAuthState(instanceId: string, authState: AuthState): Promise<void> {
    try {
      const sessionData: SessionData = {
        instanceId,
        authState,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastAccess: new Date()
      };
      
      // Cria o objeto completo no formato JSON solicitado
      const completeSessionData = {
        creds: authState.creds || {},
        keys: {
          preKeys: authState.keys?.preKeys || {},
          sessions: authState.keys?.sessions || {},
          senderKeys: authState.keys?.senderKeys || {},
          appStateSyncKeys: authState.keys?.appStateSyncKeys || {},
          appStateVersions: authState.keys?.appStateVersions || {}
        },
        deviceId: authState.deviceId,
        phoneNumber: authState.phoneNumber,
        profileName: authState.profileName,
        platform: authState.platform,
        lastAccountSyncTimestamp: authState.lastAccountSyncTimestamp
      };
      
      // Serializa credenciais individuais para campos específicos (compatibilidade)
      const serializedAuthState = this.serializeAuthState(authState);
      
      // Salva as chaves separadamente no banco (mantém estrutura existente)
      await this.saveKeysToDatabase(instanceId, authState.keys || {});

      // Removido: persistência legada de JSON em sessions (schema atualizado usa registros binários por jid+device)
      
      // Atualiza a instância apenas com as credenciais (sem sessionData)
      await prisma.instance.upsert({
        where: { instanceId },
        update: {
          numberDevice: authState.phoneNumber || null,
          status: this.hasValidCredentials(authState.creds) ? 'connected' : 'disconnected',

        },
        create: {
          id: instanceId,
          instanceId,
          nameDevice: `BZap-${instanceId}`,
          numberDevice: authState.phoneNumber || null,
          webhookUrl: null,
          events: ['messages', 'connection'],
          status: this.hasValidCredentials(authState.creds) ? 'connected' : 'disconnected',
        }
      });
      
      // Atualiza cache
      this.sessionCache.set(instanceId, sessionData);
      
      Logger.info(`💾 Estado de autenticação salvo no banco para instância: ${instanceId}`);
      
    } catch (error) {
      Logger.error(`❌ Erro ao salvar estado de autenticação da instância ${instanceId}:`, error);
      throw error;
    }
  }

  /**
   * Carrega estado de autenticação do banco
   */
  public async getAuthState(instanceId: string): Promise<AuthState | null> {
    try {
      // Verifica cache primeiro
      if (this.sessionCache.has(instanceId)) {
        const cached = this.sessionCache.get(instanceId)!;
        cached.lastAccess = new Date();
        return cached.authState;
      }
      
      const instance = await prisma.instance.findUnique({
        where: { instanceId }
      });
      
      if (!instance) {
        return null;
      }
      
      // Reconstrói estado via método legado (sem usar JSON sessionData)
      const authState = await this.loadAuthStateLegacy(instanceId, instance);
      
      // Cria dados de sessão para cache
      const sessionData: SessionData = {
        instanceId,
        authState,
        createdAt: instance.createdAt,
        updatedAt: instance.updatedAt,
        lastAccess: new Date()
      };
      
      // Atualiza cache
      this.sessionCache.set(instanceId, sessionData);
      
      return authState;
      
    } catch (error) {
      Logger.error(`❌ Erro ao carregar estado de autenticação da instância ${instanceId}:`, error);
      return null;
    }
  }

  /**
   * Método legado para carregar estado de autenticação (compatibilidade)
   */
  private async loadAuthStateLegacy(instanceId: string, instance: any): Promise<AuthState> {
    // Carrega as chaves do banco
    const keys = await this.loadKeysFromDatabase(instanceId);
    
    // Deserializa as credenciais
    const authState: AuthState = {
      creds: {
        noiseKey: instance.noiseKeyPrivate ? Buffer.from(instance.noiseKeyPrivate) : undefined,
        signedIdentityKey: instance.signedIdentityKeyPrivate ? Buffer.from(instance.signedIdentityKeyPrivate) : undefined,
        signedPreKey: instance.signedPreKeyPrivate ? Buffer.from(instance.signedPreKeyPrivate) : undefined,
        identityKey: instance.signedIdentityKeyPublic ? Buffer.from(instance.signedIdentityKeyPublic) : undefined,
        registrationId: instance.registrationId || undefined,
        advSecretKey: instance.advSecretKey || undefined,
        nextPreKeyId: instance.nextPreKeyId || undefined,
        firstUnuploadedPreKeyId: instance.firstUnuploadedPreKeyId || undefined,
        serverHasPreKeys: instance.serverHasPreKeys || false
      },
      keys,
      deviceId: instanceId,
      phoneNumber: instance.numberDevice || undefined,
      profileName: instance.nameDevice || undefined,
      platform: 'web',
      lastAccountSyncTimestamp: instance.updatedAt.getTime()
    };
    
    Logger.info(`📂 Estado carregado pelo método legado para: ${instanceId}`);
    return authState;
  }

  /**
   * Atualiza credenciais específicas
   */
  public async updateCredentials(instanceId: string, creds: Partial<AuthState['creds']>): Promise<void> {
    try {
      let authState = await this.getAuthState(instanceId);
      
      if (!authState) {
        authState = { creds: {}, keys: {} };
      }
      
      authState.creds = { ...authState.creds, ...creds };
      
      await this.saveAuthState(instanceId, authState);
      
      Logger.info(`🔑 Credenciais atualizadas para instância: ${instanceId}`);
      
    } catch (error) {
      Logger.error(`❌ Erro ao atualizar credenciais da instância ${instanceId}:`, error);
      throw error;
    }
  }

  /**
   * Atualiza chaves específicas
   */
  public async updateKeys(instanceId: string, keys: Partial<AuthState['keys']>): Promise<void> {
    try {
      let authState = await this.getAuthState(instanceId);
      
      if (!authState) {
        authState = { creds: {}, keys: {} };
      }
      
      authState.keys = { ...authState.keys, ...keys };
      
      await this.saveAuthState(instanceId, authState);
      
      Logger.info(`🔐 Chaves atualizadas para instância: ${instanceId}`);
      
    } catch (error) {
      Logger.error(`❌ Erro ao atualizar chaves da instância ${instanceId}:`, error);
      throw error;
    }
  }

  /**
   * Remove dados de uma instância do banco
   */
  public async removeInstanceData(instanceId: string): Promise<void> {
    try {
      // Remove todas as chaves relacionadas
      await Promise.all([
        prisma.preKey.deleteMany({ where: { instanceId } }),
        prisma.session.deleteMany({ where: { instanceId } }),
        prisma.senderKey.deleteMany({ where: { instanceId } }),
        prisma.appStateKey.deleteMany({ where: { instanceId } }),
        prisma.appStateVersion.deleteMany({ where: { instanceId } }),
        prisma.connectionLog.deleteMany({ where: { instanceId } }),
        prisma.messageLog.deleteMany({ where: { instanceId } }),
        prisma.instance.delete({ where: { instanceId } })
      ]);
      
      // Remove do cache
      this.sessionCache.delete(instanceId);
      this.configCache.delete(instanceId);
      
      Logger.info(`🗑️ Dados removidos do banco para instância: ${instanceId}`);
      
    } catch (error) {
      Logger.error(`❌ Erro ao remover dados da instância ${instanceId}:`, error);
      throw error;
    }
  }

  /**
   * Salva chaves no banco de dados
   */
  private async saveKeysToDatabase(instanceId: string, keys: AuthState['keys']): Promise<void> {
    if (!keys) return;

    const promises: Promise<any>[] = [];

    // Salva preKeys
    if (keys.preKeys) {
      for (const [keyId, keyData] of Object.entries(keys.preKeys)) {
        const keyB64 = Buffer.isBuffer(keyData as any)
          ? (keyData as any as Buffer).toString('base64')
          : Buffer.from(keyData as any).toString('base64');
        promises.push(
          prisma.preKey.upsert({
            where: {
              instanceId_keyId: {
                instanceId,
                keyId: parseInt(keyId)
              }
            },
            update: {
              privateKey: keyB64,
              used: false
            },
            create: {
              instanceId,
              keyId: parseInt(keyId),
              privateKey: keyB64,
              publicKey: keyB64, // Assumindo que publicKey é derivada ou igual
              used: false
            }
          })
        );
      }
    }

    // Salva sessions
    if (keys.sessions) {
      for (const [sessionId, sessionData] of Object.entries(keys.sessions)) {
        const [jid, deviceStr] = sessionId.split(':');
        const device = Number(deviceStr) || 0;
        promises.push(
          prisma.session.upsert({
            where: {
              instanceId_jid_device: {
                instanceId,
                jid,
                device
              }
            },
            update: {
              record: Buffer.from(sessionData as any)
            },
            create: {
              instanceId,
              jid,
              device,
              record: Buffer.from(sessionData as any)
            }
          })
        );
      }
    }

    // Salva senderKeys
    if (keys.senderKeys) {
      for (const [groupId, senderKeyGroup] of Object.entries(keys.senderKeys)) {
        for (const [senderId, keyData] of Object.entries(senderKeyGroup)) {
          promises.push(
            prisma.senderKey.upsert({
              where: {
                instanceId_groupId_senderId: {
                  instanceId,
                  groupId,
                  senderId
                }
              },
              update: {
                senderKey: Buffer.from(keyData)
              },
              create: {
                instanceId,
                groupId,
                senderId,
                senderKey: Buffer.from(keyData)
              }
            })
          );
        }
      }
    }

    // Salva appStateSyncKeys
    if (keys.appStateSyncKeys) {
      for (const [keyId, keyData] of Object.entries(keys.appStateSyncKeys)) {
        promises.push(
          prisma.appStateKey.upsert({
            where: {
              instanceId_keyId: {
                instanceId,
                keyId
              }
            },
            update: {
              keyData: Buffer.from(JSON.stringify(keyData), 'utf8')
            },
            create: {
              id: `${instanceId}:${keyId}`,
              instanceId,
              keyId,
              keyData: Buffer.from(JSON.stringify(keyData), 'utf8')
            }
          })
        );
      }
    }

    // Salva appStateVersions
    if (keys.appStateVersions) {
      for (const [name, version] of Object.entries(keys.appStateVersions)) {
        promises.push(
          prisma.appStateVersion.upsert({
            where: {
              instanceId_name: {
                instanceId,
                name
              }
            },
            update: {
              version,
              updatedAt: new Date()
            },
            create: {
              instanceId,
              name,
              version,
              createdAt: new Date(),
              updatedAt: new Date()
            }
          })
        );
      }
    }

    await Promise.all(promises);
  }

  /**
   * Carrega chaves do banco de dados
   */
  private async loadKeysFromDatabase(instanceId: string): Promise<AuthState['keys']> {
    const [preKeys, sessions, senderKeys, appStateSyncKeys, appStateVersions] = await Promise.all([
      prisma.preKey.findMany({ where: { instanceId } }),
      prisma.session.findMany({ where: { instanceId } }),
      prisma.senderKey.findMany({ where: { instanceId } }),
      prisma.appStateKey.findMany({ where: { instanceId } }),
      prisma.appStateVersion.findMany({ where: { instanceId } })
    ]);

    const keys: AuthState['keys'] = {};

    // Carrega preKeys
    if (preKeys.length > 0) {
      keys.preKeys = {};
      preKeys.forEach((preKey: any) => {
        keys.preKeys![preKey.keyId] = Buffer.from(preKey.privateKey, 'base64');
      });
    }

    // Carrega sessions
    if (sessions.length > 0) {
      keys.sessions = {};
      sessions.forEach((session: any) => {
        const id = `${session.jid}:${session.device}`;
        keys.sessions![id] = Buffer.from(session.record);
      });
    }

    // Carrega senderKeys
    if (senderKeys.length > 0) {
      keys.senderKeys = {};
      senderKeys.forEach((senderKey: any) => {
        if (!keys.senderKeys![senderKey.groupId]) {
          keys.senderKeys![senderKey.groupId] = {};
        }
        keys.senderKeys![senderKey.groupId][senderKey.senderId] = Buffer.from(senderKey.senderKey);
      });
    }

    // Carrega appStateSyncKeys
    if (appStateSyncKeys.length > 0) {
      keys.appStateSyncKeys = {};
      appStateSyncKeys.forEach((key: any) => {
        keys.appStateSyncKeys![key.keyId] = Buffer.from(key.keyData);
      });
    }

    // Carrega appStateVersions
    if (appStateVersions.length > 0) {
      keys.appStateVersions = {};
      appStateVersions.forEach((version: any) => {
        keys.appStateVersions![version.name] = version.version;
      });
    }

    return keys;
  }

  /**
   * Serializa estado de autenticação para armazenamento
   */
  private serializeAuthState(authState: AuthState): any {
    if (!authState.creds) return { creds: {} };

    const serialized: any = { creds: {} };

    Object.keys(authState.creds).forEach(key => {
      const value = (authState.creds as any)[key];
      if (Buffer.isBuffer(value)) {
        serialized.creds[key] = value.toString('base64');
      } else if (value && typeof value === 'object' && value.private && value.public) {
        // Para objetos com private/public (como noiseKey, signedIdentityKey)
        serialized.creds[key] = {
          private: Buffer.isBuffer(value.private) ? value.private.toString('base64') : value.private,
          public: Buffer.isBuffer(value.public) ? value.public.toString('base64') : value.public
        };
      } else if (value && typeof value === 'object' && value.keyPair) {
        // Para signedPreKey que tem keyPair
        serialized.creds[key] = {
          keyId: value.keyId,
          keyPair: {
            private: Buffer.isBuffer(value.keyPair.private) ? value.keyPair.private.toString('base64') : value.keyPair.private,
            public: Buffer.isBuffer(value.keyPair.public) ? value.keyPair.public.toString('base64') : value.keyPair.public
          },
          signature: Buffer.isBuffer(value.signature) ? value.signature.toString('base64') : value.signature
        };
      } else {
        serialized.creds[key] = value;
      }
    });

    return serialized;
  }

  /**
   * Deserializa credenciais do armazenamento
   */
  private deserializeCredentials(data: any): AuthState['creds'] {
    if (!data) return undefined;

    const creds: any = {};

    Object.keys(data).forEach(key => {
      const value = data[key];
      if (typeof value === 'string' && ['noiseKey', 'signedIdentityKey', 'signedPreKey', 'identityKey'].includes(key)) {
        creds[key] = Buffer.from(value, 'base64');
      } else {
        creds[key] = value;
      }
    });

    return creds;
  }

  /**
   * Limpa cache de sessões antigas
   */
  public cleanupCache(): void {
    const now = new Date();
    const maxAge = 24 * 60 * 60 * 1000; // 24 horas
    
    for (const [instanceId, sessionData] of this.sessionCache) {
      if (now.getTime() - sessionData.lastAccess.getTime() > maxAge) {
        this.sessionCache.delete(instanceId);
        Logger.info(`🧹 Cache de sessão limpo para instância: ${instanceId}`);
      }
    }
  }

  /**
   * Obtém estatísticas das sessões
   */
  public getStats(): {
    totalSessions: number;
    cachedSessions: number;
    totalConfigs: number;
    cachedConfigs: number;
  } {
    return {
      totalSessions: this.sessionCache.size,
      cachedSessions: this.sessionCache.size,
      totalConfigs: this.configCache.size,
      cachedConfigs: this.configCache.size
    };
  }

  /**
   * Lista todas as instâncias no banco
   */
  public async listInstances(): Promise<string[]> {
    try {
      const instances = await prisma.instance.findMany({
        select: { instanceId: true }
      });
      return instances.map(instance => instance.instanceId);
    } catch (error) {
      Logger.error('❌ Erro ao listar instâncias:', error);
      return [];
    }
  }

  /**
   * Verifica se uma instância existe no banco
   */
  public async hasInstance(instanceId: string): Promise<boolean> {
    try {
      const instance = await prisma.instance.findUnique({
        where: { instanceId }
      });
      return !!instance;
    } catch (error) {
      Logger.error(`❌ Erro ao verificar instância ${instanceId}:`, error);
      return false;
    }
  }
}