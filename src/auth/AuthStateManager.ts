// AuthStateManager.ts - Gerenciador de estado de autenticação com Prisma

import { randomBytes } from 'crypto';
import { Curve } from '../crypto/Curve25519';
import { Logger } from '../utils/Logger';
import { Mutex } from 'async-mutex';
import { BufferJSON } from '../utils/BufferJSON';
import { prisma } from '../database/PrismaClient';

/**
 * Interface para credenciais de autenticação (compatível com Baileys)
 */
export interface AuthenticationCreds {
  noiseKey: KeyPair;
  pairingEphemeralKeyPair: KeyPair;
  signedIdentityKey: KeyPair;
  signedPreKey: SignedKeyPair;
  registrationId: number;
  advSecretKey: string;
  nextPreKeyId: number;
  firstUnuploadedPreKeyId: number;
  serverHasPreKeys: boolean;
  // Campos obrigatórios seguindo padrão Baileys
  processedHistoryMessages: any[];
  accountSyncCounter: number;
  accountSettings: {
    unarchiveChats: boolean;
  };
  registered: boolean;
  pairingCode?: string;
  lastPropHash?: string;
  routingInfo?: any;
  // ✅ NOVA PROPRIEDADE: companion_enc_static para reconexões
  companionKey?: Buffer;
  // Campos opcionais
  account?: {
    details: string;
    accountSignatureKey: string;
    accountSignature: string;
    deviceSignature: string;
  };
  me?: {
    id: string;
    name?: string;
    lid?: string;
  };
  signalIdentities?: SignalIdentity[];
  myAppStateKeyId?: string;
  lastAccountSyncTimestamp?: number;
  platform?: string;
}

/**
 * Interface para par de chaves
 */
export interface KeyPair {
  private: Buffer;
  public: Buffer;
}

/**
 * Interface para par de chaves assinado
 */
export interface SignedKeyPair {
  keyId: number;
  keyPair: KeyPair;
  signature: Buffer;
}

/**
 * Interface para identidade Signal
 */
export interface SignalIdentity {
  identifier: {
    name: string;
    deviceId: number;
  };
  identifierKey: Buffer;
}

/**
 * Interface para chaves Signal Protocol (compatível com Baileys)
 */
export interface SignalDataTypeMap {
  'pre-key': {
    keyId: number;
    public: Buffer;
    private: Buffer;
  };
  'session': {
    id: string;
    session: any;
  };
  'sender-key': {
    groupId: string;
    senderId: string;
    senderKey: Buffer;
  };
  'app-state-sync-key': {
    keyId: string;
    keyData: Buffer;
  };
  'app-state-sync-version': {
    version: number;
    hash: Buffer;
  };
  'sender-key-memory': any;
}

/**
 * Interface para armazenamento de chaves Signal (compatível com Baileys)
 */
export interface SignalKeyStore {
  get: (type?: string, ids?: string[]) => Promise<{ [id: string]: any }> | { [id: string]: any };
  set: (data: { [type: string]: { [id: string]: any } }) => Promise<void>;
  // Métodos opcionais para integração com limpeza/gerenciamento de pre-keys
  markPreKeyAsUsed?: (keyId: number) => Promise<void>;
  updateNextPreKeyId?: (nextId: number) => Promise<void>;
}

/**
 * Interface para estado de autenticação completo (compatível com Baileys)
 */
export interface AuthenticationState {
  creds: AuthenticationCreds;
  keys: SignalKeyStore;
}

/**
 * Gerenciador de estado de autenticação com Prisma
 */
export class AuthStateManager {
  private instanceId: string;

  // Cache em memória para as chaves
  private keysCache: Map<string, any> = new Map();
  private keysCacheLoaded: boolean = false;

  // Mutex para controlar salvamento concorrente
  private saveMutex = new Mutex();

  constructor(instanceId: string) {
    this.instanceId = instanceId;
  }

  /**
   * Inicializa um novo estado de autenticação
   */
  public async initAuthState(): Promise<AuthenticationState> {
    Logger.info(`🔐 Inicializando novo estado de autenticação para: ${this.instanceId}`);

    const creds = this.generateAuthCreds();
    const keys = this.createKeysStore();

    const authState: AuthenticationState = {
      creds,
      keys
    };

    // Salva o estado inicial no banco
    await this.saveCreds(creds);

    Logger.info(`✅ Estado de autenticação inicializado para: ${this.instanceId}`);
    return authState;
  }

  /**
   * Carrega estado de autenticação existente
   */
  public async loadAuthState(): Promise<AuthenticationState | null> {
    try {
      const creds = await this.loadCreds();
      if (!creds) {
        return null;
      }

      const keys = this.createKeysStore();
      await this.loadKeysToCache();

      Logger.info(`📂 Estado de autenticação carregado para: ${this.instanceId}`);

      return {
        creds,
        keys
      };
    } catch (error) {
      Logger.error(`❌ Erro ao carregar estado de autenticação para ${this.instanceId}:`, error);
      return null;
    }
  }

  /**
   * Salva as credenciais no banco
   */
  public async saveCreds(creds: AuthenticationCreds): Promise<void> {
    try {
      await prisma.credential.upsert({
        where: { instanceId: this.instanceId },
        update: {
          registrationId: creds.registrationId,
          noiseKey: this.keyPairToString(creds.noiseKey),
          identityKey: this.keyPairToString(creds.signedIdentityKey),
          advSecretKey: creds.advSecretKey,
          signedPreKeyId: creds.signedPreKey?.keyId ?? null,
          signedPreKeyPub: creds.signedPreKey?.keyPair?.public ? Buffer.from(creds.signedPreKey.keyPair.public).toString('base64') : null,
          signedPreKeyPriv: creds.signedPreKey?.keyPair?.private ? Buffer.from(creds.signedPreKey.keyPair.private).toString('base64') : null,
          signedPreKeySig: creds.signedPreKey?.signature ? Buffer.from(creds.signedPreKey.signature).toString('base64') : null,
          companionKey: creds.companionKey ? Buffer.from(creds.companionKey).toString('base64') : null,
          updatedAt: new Date()
        },
        create: {
          instanceId: this.instanceId,
          registrationId: creds.registrationId,
          noiseKey: this.keyPairToString(creds.noiseKey),
          identityKey: this.keyPairToString(creds.signedIdentityKey),
          advSecretKey: creds.advSecretKey,
          signedPreKeyId: creds.signedPreKey?.keyId ?? null,
          signedPreKeyPub: creds.signedPreKey?.keyPair?.public ? Buffer.from(creds.signedPreKey.keyPair.public).toString('base64') : null,
          signedPreKeyPriv: creds.signedPreKey?.keyPair?.private ? Buffer.from(creds.signedPreKey.keyPair.private).toString('base64') : null,
          signedPreKeySig: creds.signedPreKey?.signature ? Buffer.from(creds.signedPreKey.signature).toString('base64') : null,
          companionKey: creds.companionKey ? Buffer.from(creds.companionKey).toString('base64') : null,
          updatedAt: new Date()
        }
      });

      // Persistir campos complementares em Instance (registered, me, platform, etc.)
      const meId = creds.me?.id || null;
      const meName = creds.me?.name || null;
      const platform = creds.platform || null;
      await prisma.instance.update({
        where: { instanceId: this.instanceId },
        data: {
          numberDevice: meId ?? undefined,
          nameDevice: meName ?? undefined,
          platform: platform ?? undefined,
          status: creds.registered ? 'connected' : 'disconnected',
          updatedAt: new Date()
        }
      }).catch(() => {
        // Se a instância ainda não existe, cria
        return prisma.instance.create({
          data: {
            id: this.instanceId,
            instanceId: this.instanceId,
            numberDevice: meId ?? undefined,
            nameDevice: meName ?? undefined,
            platform: platform ?? undefined,
            status: creds.registered ? 'connected' : 'disconnected'
          }
        });
      });

      Logger.info(`💾 Credenciais atualizadas em credentials para ${this.instanceId}`);
    } catch (error) {
      Logger.error(`❌ Erro ao salvar credenciais para ${this.instanceId}:`, error);
      throw error;
    }
  }

  /**
   * Salva o estado completo de autenticação no banco (padrão Baileys)
   */
  public async saveSessionToDB(sessionId: string, state: AuthenticationState): Promise<void> {
    // Novo schema não armazena o estado completo em uma única linha.
    // Mantemos este método para compatibilidade, salvando somente creds.
    await this.saveCreds(state.creds);
  }

  /**
   * Carrega o estado de autenticação do banco (padrão Baileys)
   */
  public async loadSessionFromDB(sessionId: string): Promise<AuthenticationState | null> {
    // Com o novo schema, reconstruímos o estado a partir das tabelas dedicadas
    const creds = await this.loadCreds();
    if (!creds) return null;
    const keys = this.createKeysStore();
    await this.loadKeysToCache();
    return { creds, keys };
  }

  /**
   * Serializa as chaves para armazenamento no banco
   */
  private async serializeKeys(keys: SignalKeyStore): Promise<any> {
    const allKeys = await keys.get();
    const serializedKeys: any = {};

    for (const [key, value] of Object.entries(allKeys)) {
      if (Buffer.isBuffer(value)) {
        serializedKeys[key] = value.toString('base64');
      } else if (typeof value === 'object' && value !== null) {
        serializedKeys[key] = this.serializeObject(value);
      } else {
        serializedKeys[key] = value;
      }
    }

    return serializedKeys;
  }

  /**
   * Desserializa as chaves do banco
   */
  private async deserializeKeys(serializedKeys: any): Promise<SignalKeyStore> {
    const keysStore = this.createKeysStore();
    const keysToSet: any = {};

    for (const [key, value] of Object.entries(serializedKeys)) {
      if (typeof value === 'string' && key.includes('session')) {
        keysToSet[key] = Buffer.from(value, 'base64');
      } else if (typeof value === 'object' && value !== null) {
        keysToSet[key] = this.deserializeObject(value);
      } else {
        keysToSet[key] = value;
      }
    }

    await keysStore.set(keysToSet);
    return keysStore;
  }

  /**
   * Serializa objetos com buffers para base64
   */
  private serializeObject(obj: any): any {
    if (Buffer.isBuffer(obj)) {
      return obj.toString('base64');
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.serializeObject(item));
    }

    if (typeof obj === 'object' && obj !== null) {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.serializeObject(value);
      }
      return result;
    }

    return obj;
  }

  /**
   * Desserializa objetos com base64 para buffers
   */
  private deserializeObject(obj: any): any {
    if (typeof obj === 'string' && obj.length > 100) {
      // Heurística: strings longas podem ser base64
      try {
        return Buffer.from(obj, 'base64');
      } catch {
        return obj;
      }
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.deserializeObject(item));
    }

    if (typeof obj === 'object' && obj !== null) {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.deserializeObject(value);
      }
      return result;
    }

    return obj;
  }

  /**
   * Helpers para serialização de KeyPair em string JSON base64 (compatível com novo schema)
   */
  private keyPairToString(kp: KeyPair): string {
    return JSON.stringify({
      private: Buffer.from(kp.private).toString('base64'),
      public: Buffer.from(kp.public).toString('base64')
    });
  }

  private keyPairFromString(s: string | null | undefined): KeyPair | null {
    if (!s) return null;
    try {
      const obj = JSON.parse(s);
      return {
        private: Buffer.from(obj.private, 'base64'),
        public: Buffer.from(obj.public, 'base64')
      };
    } catch (e) {
      Logger.warn(`⚠️ keyPairFromString: falha ao parsear string`, e);
      return null;
    }
  }

  /**
   * Helper para parsear id de sessão no formato "jid[:device]"
   */
  private parseSessionId(id: string): { jid: string; device: number } {
    // Suporta dois formatos de ID de sessão:
    // 1) "jid:device" (padrão atual)
    // 2) "jid.device" (legado)
    // Prioriza separador ':'; se não houver, tenta '.' como separador de device

    // Formato padrão com ':'
    if (id.includes(':')) {
      const parts = id.split(':');
      const maybeDevice = parts[parts.length - 1];
      if (/^\d+$/.test(maybeDevice)) {
        return { jid: parts.slice(0, -1).join(':'), device: parseInt(maybeDevice, 10) || 0 };
      }
    }

    // Formato legado com '.'
    const lastDot = id.lastIndexOf('.');
    if (lastDot > 0) {
      const maybeDevice = id.substring(lastDot + 1);
      if (/^\d+$/.test(maybeDevice)) {
        Logger.debug(`⚠️ Formato legado de ID de sessão detectado: ${id}, convertendo para formato padrão`);
        return { jid: id.substring(0, lastDot), device: parseInt(maybeDevice, 10) || 0 };
      }
    }

    return { jid: id, device: 0 };
  }



  /**
   * Carrega as credenciais do banco
   */
  public async loadCreds(): Promise<AuthenticationCreds | null> {
    try {
      const cred = await prisma.credential.findUnique({ where: { instanceId: this.instanceId } });
      const inst = await prisma.instance.findUnique({ where: { instanceId: this.instanceId } });

      if (!cred) {
        return null;
      }

      const noiseKey = this.keyPairFromString(cred.noiseKey);
      const identityKey = this.keyPairFromString(cred.identityKey);

      if (!noiseKey || !identityKey) {
        Logger.warn(`⚠️ Credenciais incompletas em credentials para ${this.instanceId}`);
        return null;
      }

      const signedPreKey: SignedKeyPair | undefined = cred.signedPreKeyId != null && cred.signedPreKeyPriv && cred.signedPreKeyPub && cred.signedPreKeySig
        ? {
          keyId: cred.signedPreKeyId!,
          keyPair: {
            private: Buffer.from(cred.signedPreKeyPriv, 'base64'),
            public: Buffer.from(cred.signedPreKeyPub, 'base64')
          },
          signature: Buffer.from(cred.signedPreKeySig, 'base64')
        }
        : undefined;

      // Verificar se precisamos gerar uma nova signedPreKey
      let finalSignedPreKey = signedPreKey;
      if (!finalSignedPreKey) {
        const newSigned = this.generateSignedKeyPair(identityKey, 1);
        finalSignedPreKey = newSigned;

        // Reconstruir AuthenticationCreds para salvar corretamente
        const updatedCreds: AuthenticationCreds = {
          noiseKey,
          pairingEphemeralKeyPair: Curve.generateKeyPair(), // gera um novo par efêmero
          signedIdentityKey: identityKey,
          signedPreKey: newSigned,
          registrationId: cred.registrationId,
          advSecretKey: cred.advSecretKey || Buffer.from(randomBytes(32)).toString('base64'),
          nextPreKeyId: 1,
          firstUnuploadedPreKeyId: 1,
          serverHasPreKeys: false,
          processedHistoryMessages: [],
          accountSyncCounter: 0,
          accountSettings: { unarchiveChats: false },
          registered: inst?.status === 'connected',
          me: inst?.numberDevice ? { id: inst.numberDevice, name: inst?.nameDevice || undefined } : undefined,
          platform: inst?.platform || undefined,
          companionKey: cred.companionKey ? Buffer.from(cred.companionKey, 'base64') : undefined,
        };

        await this.saveCreds(updatedCreds);
        Logger.info(`🔑 [AUTH] SignedPreKey gerada e salva no banco para ${this.instanceId}`);
      }

      const creds: AuthenticationCreds = {
        noiseKey,
        pairingEphemeralKeyPair: Curve.generateKeyPair(),
        signedIdentityKey: identityKey,
        signedPreKey: finalSignedPreKey,
        registrationId: cred.registrationId,
        advSecretKey: cred.advSecretKey || Buffer.from(randomBytes(32)).toString('base64'),
        nextPreKeyId: 1,
        firstUnuploadedPreKeyId: 1,
        serverHasPreKeys: false,
        processedHistoryMessages: [],
        companionKey: cred.companionKey ? Buffer.from(cred.companionKey, 'base64') : undefined,
        accountSyncCounter: 0,
        accountSettings: { unarchiveChats: false },
        registered: inst?.status === 'connected',
        me: inst?.numberDevice ? { id: inst.numberDevice, name: inst?.nameDevice || undefined } : undefined,
        platform: inst?.platform || undefined
      };

      return creds;
    } catch (error) {
      Logger.error(`❌ Erro ao carregar credenciais para ${this.instanceId}:`, error);
      return null;
    }
  }

  /**
   * Carrega as chaves do banco para o cache
   */
  private async loadKeysToCache(): Promise<void> {
    if (this.keysCacheLoaded) return;

    try {
      // PreKeys
      const preKeys = await prisma.preKey.findMany({ where: { instanceId: this.instanceId } });
      for (const preKey of preKeys) {
        this.keysCache.set(`pre-key:${preKey.keyId}`, {
          keyId: preKey.keyId,
          public: Buffer.from(preKey.publicKey, 'base64'),
          private: Buffer.from(preKey.privateKey, 'base64')
        });
      }

      // Signed PreKey (ativo) nas credenciais
      const cred = await prisma.credential.findUnique({ where: { instanceId: this.instanceId } });
      if (cred && cred.signedPreKeyId && cred.signedPreKeyPriv && cred.signedPreKeyPub && cred.signedPreKeySig) {
        this.keysCache.set(`signed-pre-key:${cred.signedPreKeyId}`, {
          keyId: cred.signedPreKeyId,
          keyPair: {
            private: Buffer.from(cred.signedPreKeyPriv, 'base64'),
            public: Buffer.from(cred.signedPreKeyPub, 'base64')
          },
          signature: Buffer.from(cred.signedPreKeySig, 'base64')
        });
        Logger.debug(`🔑 SignedPreKey carregada: ID ${cred.signedPreKeyId}`);
      }

      // Sessions (jid + device) - usar formato com ":" SEMPRE
      const sessions = await prisma.session.findMany({ where: { instanceId: this.instanceId } });
      for (const s of sessions) {
        const id = `${s.jid}:${s.device}`; // usar ":" SEMPRE
        this.keysCache.set(`session:${id}`, { id, session: s.record as any });
      }

      // Sender Keys
      const senderKeys = await prisma.senderKey.findMany({ where: { instanceId: this.instanceId } });
      for (const sk of senderKeys) {
        const key = `${sk.groupId}:${sk.senderId}`;
        this.keysCache.set(`sender-key:${key}`, { groupId: sk.groupId, senderId: sk.senderId, senderKey: Buffer.from(sk.senderKey) });
      }

      // Signal Identities
      const identities = await prisma.identity.findMany({ where: { instanceId: this.instanceId } });
      for (const ident of identities) {
        // ✅ Prefixo corrigido: 'identity' para compatibilidade com SignalProtocolStore.get('identity')
        const rawKey = Buffer.from(ident.identityKey, 'base64');
        const formattedKey = rawKey.length === 33
          ? rawKey
          : Buffer.concat([Buffer.from([0x05]), rawKey]);
        this.keysCache.set(`identity:${ident.jid}`, {
          jid: ident.jid,
          identityKey: formattedKey
        });

      }

      // App State Keys
      const appStateKeys = await prisma.appStateKey.findMany({ where: { instanceId: this.instanceId } });
      for (const k of appStateKeys) {
        // Garante que keyData seja sempre um Buffer válido
        const keyDataBuf = Buffer.isBuffer(k.keyData)
          ? k.keyData
          : typeof k.keyData === 'string'
            ? Buffer.from(k.keyData, 'base64')
            : Buffer.from(k.keyData);
        this.keysCache.set(`app-state-sync-key:${k.keyId}`, { keyId: k.keyId, keyData: keyDataBuf });
      }

      // App State Versions
      const appStateVersions = await prisma.appStateVersion.findMany({ where: { instanceId: this.instanceId } });
      for (const v of appStateVersions) {
        this.keysCache.set(`app-state-sync-version:${v.name}`, { version: v.version, hash: v.hash ? Buffer.from(v.hash) : Buffer.alloc(0) });
      }

      this.keysCacheLoaded = true;
      Logger.debug(`🔑 Chaves carregadas do banco para: ${this.instanceId}`);
    } catch (error) {
      Logger.error(`❌ Erro ao carregar chaves para ${this.instanceId}:`, error);
    }
  }

  /**
   * Cria o store de chaves compatível com Baileys
   */
  private createKeysStore(): SignalKeyStore {
    return {
      get: async (type?: string, ids?: string[]) => {
        await this.loadKeysToCache();

        // Se não especificar type, retorna todas as chaves (para debugging)
        if (!type) {
          const allKeys: { [id: string]: any } = {};
          for (const [key, value] of this.keysCache.entries()) {
            allKeys[key] = value;
          }
          return allKeys;
        }

        // Se não especificar ids, retorna todas as chaves do tipo
        if (!ids) {
          const result: { [id: string]: any } = {};
          for (const [key, value] of this.keysCache.entries()) {
            if (key.startsWith(`${type}:`)) {
              const id = key.substring(type.length + 1);
              result[id] = value;
            }
          }
          return result;
        }

        // Comportamento normal: busca chaves específicas
        const result: { [id: string]: any } = {};
        for (const id of ids) {
          result[id] = this.keysCache.get(`${type}:${id}`) || null;
        }
        return result;
      },
      set: async (data: { [type: string]: { [id: string]: any } }) => {
        Logger.debug(`keyStore.set chamado`);
        Logger.debug(`Tipos de dados recebidos: ${Object.keys(data).join(', ')}`);

        // Detecta se há tipos críticos que exigem flush imediato para evitar perda
        // de dados em cenários de erro precoce (ex.: primeira pkmsg criando sessão/identidade)
        const hasCriticalTypes = Object.keys(data).some(
          (t) => t === 'session' || t === 'identity'
        );

        for (const [type, items] of Object.entries(data)) {
          Logger.debug(`Processando tipo: ${type}, quantidade de itens: ${Object.keys(items).length}`);

          for (const [id, value] of Object.entries(items)) {
            // Reduz verbosidade: não logar item a item em INFO (principalmente pre-keys)
            Logger.debug(`Processando item: ${type}/${id}`);

            if (type === 'session') {
              Logger.info(`SESSÃO DETECTADA: ${id}`);
              Logger.debug(`Valor da sessão: hasId=${!!(value as any).id}, hasSession=${!!(value as any).session}, length=${(value as any).session ? (value as any).session.length : 0}`);
            }

            const key = `${type}:${id}`;
            this.keysCache.set(key, value);
            Logger.debug(`Item ${key} adicionado ao cache`);
          }
        }

        Logger.debug(`Cache atualizado, total de itens: ${this.keysCache.size}`);
        if (hasCriticalTypes) {
          // Evita debounce para sessão/identidade: grava imediatamente no banco
          // Isso reduz a janela em que sessions/identities podem ficar vazios
          Logger.debug(`Tipos críticos detectados (session/identity). Iniciando save imediato...`);
          await this.saveKeysToDatabase();
          Logger.debug(`saveKeysToDatabase concluído (flush imediato)`);
        } else {
          Logger.debug(`Iniciando debounced save...`);
          await this.debouncedSaveKeys();
        }

        Logger.debug(`keyStore.set concluído`);
      },
      // Métodos auxiliares opcionais para integração com SignalProtocolStore/KeyManager
      // Expostos via keyStore para marcar pre-keys consumidas e atualizar o ponteiro de nextPreKeyId
      markPreKeyAsUsed: async (keyId: number) => {
        try {
          await this.markPreKeyAsUsed(keyId);
          Logger.debug(`🔖 keyStore.markPreKeyAsUsed executado para keyId=${keyId}`);
        } catch (err) {
          Logger.warn(`⚠️ Falha ao marcar pre-key como usada via keyStore: ${keyId} - ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      updateNextPreKeyId: async (nextId: number) => {
        try {
          await this.updateNextPreKeyId(nextId);
          Logger.debug(`🔖 keyStore.updateNextPreKeyId executado: nextId=${nextId}`);
        } catch (err) {
          Logger.warn(`⚠️ Falha ao atualizar nextPreKeyId via keyStore: ${nextId} - ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
  }

  /**
   * Salva as chaves no banco com debounce
   */
  private saveKeysTimeout?: NodeJS.Timeout;
  private async debouncedSaveKeys(): Promise<void> {
    Logger.debug(`debouncedSaveKeys chamado`);

    if (this.saveKeysTimeout) {
      Logger.debug(`Timeout existente cancelado`);
      clearTimeout(this.saveKeysTimeout);
    }

    this.saveKeysTimeout = setTimeout(async () => {
      Logger.debug(`Timeout executado, iniciando saveKeysToDatabase...`);
      await this.saveKeysToDatabase();
      Logger.debug(`saveKeysToDatabase concluído pelo timeout`);
    }, 100); // 100ms de debounce

    Logger.debug(`Novo timeout configurado (100ms)`);
  }

  /**
   * Persiste as chaves do cache no banco
   */
  private async saveKeysToDatabase(): Promise<void> {
    Logger.info(`💾 Persistência de chaves iniciada (cache=${this.keysCache.size})`);

    const release = await this.saveMutex.acquire();
    Logger.debug(`Mutex adquirido`);

    try {
      const operations: any[] = [];

      Logger.debug(`Processando cache...`);

      for (const [key, value] of this.keysCache.entries()) {
        const [type, id] = key.split(':', 2);
        Logger.debug(`Processando chave: ${key} (tipo: ${type}, id: ${id})`);

        switch (type) {
          case 'pre-key':
            if (value) {
              // Reduz verbosidade de pre-keys
              Logger.debug(`Salvando pre-key: ${id}`);
              operations.push(
                prisma.preKey.upsert({
                  where: {
                    instanceId_keyId: {
                      instanceId: this.instanceId,
                      keyId: parseInt(id)
                    }
                  },
                  update: {
                    publicKey: Buffer.from(value.public).toString('base64'),
                    privateKey: Buffer.from(value.private).toString('base64'),
                    used: false
                  },
                  create: {
                    instanceId: this.instanceId,
                    keyId: parseInt(id),
                    publicKey: Buffer.from(value.public).toString('base64'),
                    privateKey: Buffer.from(value.private).toString('base64'),
                    used: false
                  }
                })
              );
            }
            break;

          case 'session':
            if (value) {
              // Novo schema: id = "jid[:device]" e gravamos o record em JSON
              const { jid, device } = this.parseSessionId(id);
              // Normaliza para formato persistível (JSON-aware) tal como SignalProtocolStore
              let persistable: any;
              const rec: any = (value as any).session;
              if (Buffer.isBuffer(rec)) {
                persistable = { __type: 'bytes', base64: rec.toString('base64') };
              } else if (rec instanceof Uint8Array) {
                persistable = { __type: 'bytes', base64: Buffer.from(rec).toString('base64') };
              } else if (rec instanceof ArrayBuffer) {
                persistable = { __type: 'bytes', base64: Buffer.from(new Uint8Array(rec)).toString('base64') };
              } else if (Array.isArray(rec)) {
                persistable = { __type: 'bytes', base64: Buffer.from(rec).toString('base64') };
              } else if (typeof rec === 'string') {
                persistable = { __type: 'string', utf8: rec };
              } else if (rec && typeof rec === 'object') {
                persistable = rec;
              } else {
                Logger.warn(`⚠️ [AuthStateManager] Formato de sessão inesperado para ${jid}:${device} (tipo=${typeof rec}). Pulando persistência.`);
                break;
              }

              operations.push(
                prisma.session.upsert({
                  where: {
                    instanceId_jid_device: {
                      instanceId: this.instanceId,
                      jid,
                      device
                    }
                  },
                  update: {
                    record: persistable,
                    updatedAt: new Date()
                  },
                  create: {
                    instanceId: this.instanceId,
                    jid,
                    device,
                    record: persistable,
                    createdAt: new Date(),
                    updatedAt: new Date()
                  }
                })
              );
            } else {
              // Remoção de sessão quando value === null
              const { jid, device } = this.parseSessionId(id);
              Logger.info(`🗑️ Removendo sessão: ${jid}.${device}`);
              operations.push(
                prisma.session.delete({
                  where: {
                    instanceId_jid_device: {
                      instanceId: this.instanceId,
                      jid,
                      device
                    }
                  }
                })
              );
            }
            break;

          case 'sender-key':
            if (value) {
              const [groupId, senderId] = id.split(':', 2);
              if (!groupId || !senderId) {
                Logger.warn(`⚠️ [AuthStateManager] ID de sender-key inválido: ${id}`);
                break;
              }
              Logger.info(`💾 Salvando sender-key: ${groupId}:${senderId}`);
              operations.push(
                prisma.senderKey.upsert({
                  where: {
                    instanceId_groupId_senderId: {
                      instanceId: this.instanceId,
                      groupId: groupId,
                      senderId: senderId
                    }
                  },
                  update: {
                    senderKey: Buffer.from(value.senderKey)
                  },
                  create: {
                    instanceId: this.instanceId,
                    groupId: groupId,
                    senderId: senderId,
                    senderKey: Buffer.from(value.senderKey)
                  }
                })
              );
            } else {
              const [groupId, senderId] = id.split(':', 2);
              if (!groupId || !senderId) {
                Logger.warn(`⚠️ [AuthStateManager] ID de sender-key inválido para remoção: ${id}`);
                break;
              }
              Logger.info(`🗑️ Removendo sender-key: ${groupId}:${senderId}`);
              operations.push(
                prisma.senderKey.delete({
                  where: {
                    instanceId_groupId_senderId: {
                      instanceId: this.instanceId,
                      groupId,
                      senderId
                    }
                  }
                })
              );
            }
            break;

          case 'identity':
            if (value) {
              // id é o JID no formato name.deviceId
              // SignalProtocolStore.saveIdentity salva como { identityKey: Buffer, timestamp }
              const identityBuf = (value as any).identityKey ?? (value as any).identifierKey;
              if (!identityBuf) {
                Logger.warn(`⚠️ [AuthStateManager] Estrutura de identidade inesperada para ${id}`);
                break;
              }
              operations.push(
                prisma.identity.upsert({
                  where: {
                    instanceId_jid: {
                      instanceId: this.instanceId,
                      jid: id
                    }
                  },
                  update: {
                    identityKey: Buffer.isBuffer(identityBuf)
                      ? Buffer.from(identityBuf).toString('base64')
                      : Buffer.from(identityBuf as any).toString('base64'),
                    trustLevel: 0,
                    updatedAt: new Date()
                  },
                  create: {
                    instanceId: this.instanceId,
                    jid: id,
                    identityKey: Buffer.isBuffer(identityBuf)
                      ? Buffer.from(identityBuf).toString('base64')
                      : Buffer.from(identityBuf as any).toString('base64'),
                    trustLevel: 0,
                    updatedAt: new Date()
                  }
                })
              );
            } else {
              Logger.info(`🗑️ Removendo identidade: ${id}`);
              operations.push(
                prisma.identity.delete({
                  where: {
                    instanceId_jid: {
                      instanceId: this.instanceId,
                      jid: id
                    }
                  }
                })
              );
            }
            break;

          case 'app-state-sync-key':
            if (value) {
              operations.push(
                prisma.appStateKey.upsert({
                  where: {
                    instanceId_keyId: {
                      instanceId: this.instanceId,
                      keyId: id
                    }
                  },
                  update: {
                    keyData: Buffer.from(value.keyData)
                  },
                  create: {
                    id: `${this.instanceId}:${id}`,
                    instanceId: this.instanceId,
                    keyId: id,
                    keyData: Buffer.from(value.keyData)
                  }
                })
              );
            } else {
              operations.push(
                prisma.appStateKey.delete({
                  where: {
                    instanceId_keyId: {
                      instanceId: this.instanceId,
                      keyId: id
                    }
                  }
                })
              );
            }
            break;

          case 'app-state-sync-version':
            if (value) {
              operations.push(
                prisma.appStateVersion.upsert({
                  where: {
                    instanceId_name: {
                      instanceId: this.instanceId,
                      name: id
                    }
                  },
                  update: {
                    version: value.version,
                    hash: Buffer.from(value.hash)
                  },
                  create: {
                    instanceId: this.instanceId,
                    name: id,
                    version: value.version,
                    hash: Buffer.from(value.hash)
                  }
                })
              );
            } else {
              operations.push(
                prisma.appStateVersion.delete({
                  where: {
                    instanceId_name: {
                      instanceId: this.instanceId,
                      name: id
                    }
                  }
                })
              );
            }
            break;
        }
      }

      Logger.info(`💾 Executando ${operations.length} operações no banco`);

      if (operations.length > 0) {
        await Promise.all(operations);
        Logger.info(`✅ ${operations.length} itens salvos no banco para: ${this.instanceId}`);
      } else {
        Logger.debug(`Nenhuma operação para executar`);
      }
    } catch (error) {
      Logger.error(`❌ Erro ao salvar chaves no banco para ${this.instanceId}:`, error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      if (errorStack) {
        Logger.error(`❌ Stack trace:`, errorStack);
      }
    } finally {
      release();
      Logger.debug(`saveKeysToDatabase finalizado`);
    }
  }

  /**
   * ✅ Métodos auxiliares para persistir App State diretamente
   */
  public async saveAppStateKey(keyId: string, keyData: Buffer): Promise<void> {
    this.keysCache.set(`app-state-sync-key:${keyId}`, { keyId, keyData });
    await this.debouncedSaveKeys();
    Logger.info(`💾 AppStateKey salvo: ${keyId}`);
  }

  public async saveAppStateVersion(name: string, version: number, hash?: Buffer): Promise<void> {
    this.keysCache.set(`app-state-sync-version:${name}`, { version, hash: hash ?? Buffer.alloc(0) });
    await this.debouncedSaveKeys();
    Logger.info(`💾 AppStateVersion atualizado: ${name} -> v${version}`);
  }

  private generateAuthCreds(): AuthenticationCreds {
    // Gera chaves usando a Curve util (seguindo padrão Baileys)
    const noiseKey = Curve.generateKeyPair();
    const pairingEphemeralKeyPair = Curve.generateKeyPair();
    const signedIdentityKey = Curve.generateKeyPair();

    // Gera signed prekey corretamente (seguindo padrão Baileys)
    const keyId = 1; // Baileys usa keyId = 1 para signedPreKey inicial
    const signedPreKey = this.generateSignedKeyPair(signedIdentityKey, keyId);

    const registrationId = this.generateRegistrationId();

    const creds: AuthenticationCreds = {
      noiseKey,
      pairingEphemeralKeyPair,
      signedIdentityKey,
      signedPreKey,
      registrationId,
      advSecretKey: Buffer.from(randomBytes(32)).toString('base64'),
      nextPreKeyId: 1,
      firstUnuploadedPreKeyId: 1,
      serverHasPreKeys: false,
      // Campos adicionais seguindo padrão Baileys
      processedHistoryMessages: [],
      accountSyncCounter: 0,
      accountSettings: {
        unarchiveChats: false
      },
      registered: false,
      pairingCode: undefined,
      lastPropHash: undefined,
      routingInfo: undefined
    };

    return creds;
  }

  private generateSignedKeyPair(identityKey: KeyPair, keyId: number): SignedKeyPair {
    const preKey = Curve.generateKeyPair();
    const pubKey = Buffer.concat([Buffer.from([0x05]), Buffer.from(preKey.public)]);
    const signature = Curve.sign(identityKey.private, pubKey);
    return {
      keyId,
      keyPair: preKey,
      signature: Buffer.from(signature)
    };
  }

  private generateRegistrationId(): number {
    return Uint16Array.from(randomBytes(2))[0]! & 16383;
  }

  private serializeCreds(creds: AuthenticationCreds): any {
    return {
      noiseKey: creds.noiseKey ? {
        private: creds.noiseKey.private ? Buffer.from(creds.noiseKey.private).toString('base64') : null,
        public: creds.noiseKey.public ? Buffer.from(creds.noiseKey.public).toString('base64') : null
      } : null,
      pairingEphemeralKeyPair: creds.pairingEphemeralKeyPair ? {
        private: creds.pairingEphemeralKeyPair.private ? Buffer.from(creds.pairingEphemeralKeyPair.private).toString('base64') : null,
        public: creds.pairingEphemeralKeyPair.public ? Buffer.from(creds.pairingEphemeralKeyPair.public).toString('base64') : null
      } : null,
      signedIdentityKey: creds.signedIdentityKey ? {
        private: creds.signedIdentityKey.private ? Buffer.from(creds.signedIdentityKey.private).toString('base64') : null,
        public: creds.signedIdentityKey.public ? Buffer.from(creds.signedIdentityKey.public).toString('base64') : null
      } : null,
      signedPreKey: creds.signedPreKey ? {
        keyId: creds.signedPreKey.keyId,
        private: creds.signedPreKey.keyPair?.private ? Buffer.from(creds.signedPreKey.keyPair.private).toString('base64') : null,
        public: creds.signedPreKey.keyPair?.public ? Buffer.from(creds.signedPreKey.keyPair.public).toString('base64') : null,
        signature: creds.signedPreKey.signature ? Buffer.from(creds.signedPreKey.signature).toString('base64') : null
      } : null,
      registrationId: creds.registrationId,
      advSecretKey: creds.advSecretKey,
      nextPreKeyId: creds.nextPreKeyId,
      firstUnuploadedPreKeyId: creds.firstUnuploadedPreKeyId,
      serverHasPreKeys: creds.serverHasPreKeys,
      // Campos obrigatórios seguindo padrão Baileys
      processedHistoryMessages: creds.processedHistoryMessages || [],
      accountSyncCounter: creds.accountSyncCounter || 0,
      accountSettings: creds.accountSettings || { unarchiveChats: false },
      registered: creds.registered || false,
      // Campos opcionais mas importantes para persistência
      pairingCode: creds.pairingCode || null,
      lastPropHash: creds.lastPropHash || null,
      routingInfo: creds.routingInfo || null,
      account: creds.account || null,
      me: creds.me || null,
      signalIdentities: creds.signalIdentities || [],
      myAppStateKeyId: creds.myAppStateKeyId || null,
      lastAccountSyncTimestamp: creds.lastAccountSyncTimestamp || null,
      platform: creds.platform || null
    };
  }

  private deserializeCredsFromInstance(instance: any): AuthenticationCreds {
    // ✅ Função helper para converter Uint8Array/Buffer para Buffer
    const toBuffer = (data: any): Buffer => {
      if (Buffer.isBuffer(data)) return data;
      if (data instanceof Uint8Array) return Buffer.from(data);
      return Buffer.from(data);
    };

    // ✅ Função helper para reconstruir KeyPair com Buffer
    const toKeyPair = (privateData: any, publicData: any): KeyPair => ({
      private: toBuffer(privateData),
      public: toBuffer(publicData)
    });

    return {
      // ✅ CORREÇÃO: Convertendo para Buffer em vez de Uint8Array
      noiseKey: toKeyPair(instance.noiseKeyPrivate, instance.noiseKeyPublic),
      pairingEphemeralKeyPair: toKeyPair(instance.pairingEphemeralKeyPrivate, instance.pairingEphemeralKeyPublic),
      signedIdentityKey: toKeyPair(instance.signedIdentityKeyPrivate, instance.signedIdentityKeyPublic),
      signedPreKey: {
        keyId: instance.signedPreKeyId,
        keyPair: toKeyPair(instance.signedPreKeyPrivate, instance.signedPreKeyPublic),
        signature: toBuffer(instance.signedPreKeySignature)
      },
      registrationId: instance.registrationId,
      advSecretKey: instance.advSecretKey,
      nextPreKeyId: instance.nextPreKeyId,
      firstUnuploadedPreKeyId: instance.firstUnuploadedPreKeyId,
      serverHasPreKeys: instance.serverHasPreKeys,
      processedHistoryMessages: instance.processedHistoryMessages || [],
      accountSyncCounter: instance.accountSyncCounter || 0,
      accountSettings: instance.accountSettings || { unarchiveChats: false },
      registered: instance.registered || false,
      pairingCode: instance.pairingCode || undefined,
      lastPropHash: instance.lastPropHash || undefined,
      routingInfo: instance.routingInfo ? toBuffer(instance.routingInfo) : undefined,
      me: instance.userId ? {
        id: instance.userId,
        name: instance.userName || undefined,
        lid: instance.userLid || undefined
      } : undefined,
      signalIdentities: instance.signalIdentities || undefined,
      myAppStateKeyId: instance.myAppStateKeyId || undefined,
      lastAccountSyncTimestamp: instance.lastAccountSyncTimestamp || undefined,
      platform: instance.platform || undefined
    };
  }

  private deserializeCreds(data: any): AuthenticationCreds {
    const parseKeyPair = (obj: any): KeyPair => ({
      private: Buffer.from(obj.private, 'base64'),
      public: Buffer.from(obj.public, 'base64')
    });

    const parseSigned = (obj: any): SignedKeyPair => ({
      keyId: obj.keyId,
      keyPair: {
        private: Buffer.from(obj.private, 'base64'),
        public: Buffer.from(obj.public, 'base64')
      },
      signature: Buffer.from(obj.signature, 'base64')
    });

    return {
      noiseKey: parseKeyPair(data.noiseKey),
      pairingEphemeralKeyPair: parseKeyPair(data.pairingEphemeralKeyPair),
      signedIdentityKey: parseKeyPair(data.signedIdentityKey),
      signedPreKey: parseSigned(data.signedPreKey),
      registrationId: data.registrationId,
      advSecretKey: data.advSecretKey,
      nextPreKeyId: data.nextPreKeyId,
      firstUnuploadedPreKeyId: data.firstUnuploadedPreKeyId,
      serverHasPreKeys: data.serverHasPreKeys,
      // Campos obrigatórios seguindo padrão Baileys
      processedHistoryMessages: data.processedHistoryMessages || [],
      accountSyncCounter: data.accountSyncCounter || 0,
      accountSettings: data.accountSettings || { unarchiveChats: false },
      registered: data.registered || false,
      // Campos opcionais
      pairingCode: data.pairingCode || undefined,
      lastPropHash: data.lastPropHash || undefined,
      routingInfo: data.routingInfo || undefined,
      account: data.account || undefined,
      me: data.me || undefined,
      signalIdentities: data.signalIdentities || undefined,
      myAppStateKeyId: data.myAppStateKeyId || undefined,
      lastAccountSyncTimestamp: data.lastAccountSyncTimestamp || undefined,
      platform: data.platform || undefined
    };
  }

  /**
   * Salva o estado de autenticação completo na tabela Session
   */
  public async saveCompleteAuthState(creds: AuthenticationCreds, keys: any): Promise<void> {
    try {
      // Primeiro, garante que a instância existe no banco
      await prisma.instance.upsert({
        where: { instanceId: this.instanceId },
        update: {
          // Atualiza campos básicos se a instância já existe
          status: creds.registered ? 'connected' : 'disconnected',
          numberDevice: creds.me?.id || null,
          platform: creds.platform || null,
          updatedAt: new Date()
        },
        create: {
          // Cria nova instância com dados básicos
          id: this.instanceId,
          instanceId: this.instanceId,
          nameDevice: `BZap-${this.instanceId}`,
          numberDevice: creds.me?.id || null,
          platform: creds.platform || null,
          status: creds.registered ? 'connected' : 'disconnected',
          events: ['messages', 'connection']
        }
      });

      // Persistência do estado completo agora é feita via tabelas específicas (credentials, sessions, pre-keys, etc.)
      Logger.info(`💾 [AuthStateManager] Metadados de instância atualizados para: ${this.instanceId}`);
      Logger.info(`📊 [AuthStateManager] Status da instância (derivado de creds): ${creds.registered ? 'connected' : 'disconnected'}`);
    } catch (error) {
      Logger.error(`❌ [AuthStateManager] Erro ao salvar authState completo:`, error);
      throw error;
    }
  }

  /**
   * Carrega o estado de autenticação completo da tabela Session
   */
  public async loadCompleteAuthState(): Promise<{ creds: AuthenticationCreds; keys: any } | null> {
    try {
      // Novo fluxo: obtém creds da tabela 'credentials' e fornece um store de chaves dinâmico
      const creds = await this.loadCreds();
      if (!creds) {
        Logger.debug(`🔍 [AuthStateManager] Credenciais não encontradas para: ${this.instanceId}`);
        return null;
      }

      const keys = this.createKeysStore();
      return { creds, keys };
    } catch (error) {
      Logger.error(`❌ [AuthStateManager] Erro ao carregar authState completo:`, error);
      return null;
    }
  }

  /**
   * Serializa credenciais para armazenamento (mantém Buffers como Buffers)
   */
  private serializeCredsForStorage(creds: AuthenticationCreds): any {
    // Usa JSON.stringify com replacer para manter Buffers
    return JSON.parse(JSON.stringify(creds, (key, value) => {
      if (Buffer.isBuffer(value)) {
        return {
          type: 'Buffer',
          data: Array.from(value)
        };
      }
      return value;
    }));
  }

  /**
   * Deserializa credenciais do armazenamento (reconstrói Buffers)
   */
  private deserializeCredsFromStorage(data: any): AuthenticationCreds {
    // Usa JSON.parse com reviver para reconstruir Buffers
    return JSON.parse(JSON.stringify(data), (key, value) => {
      if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
        return Buffer.from(value.data);
      }
      return value;
    });
  }

  /**
   * Serializa keys para armazenamento (converte Buffers para base64)
   */
  private serializeKeysForStorage(keys: any): any {
    if (!keys) return {};

    const serialized: any = {};

    // Serializa pre-keys
    if (keys.preKeys) {
      serialized.preKeys = {};
      for (const [keyId, keyData] of Object.entries(keys.preKeys)) {
        if (keyData && typeof keyData === 'object') {
          serialized.preKeys[keyId] = {
            keyId: (keyData as any).keyId,
            public: Buffer.isBuffer((keyData as any).public) ? (keyData as any).public.toString('base64') : (keyData as any).public,
            private: Buffer.isBuffer((keyData as any).private) ? (keyData as any).private.toString('base64') : (keyData as any).private
          };
        }
      }
    }

    // Serializa sessions
    if (keys.sessions) {
      serialized.sessions = {};
      for (const [sessionId, sessionData] of Object.entries(keys.sessions)) {
        if (sessionData && typeof sessionData === 'object') {
          serialized.sessions[sessionId] = this.serializeSessionData(sessionData);
        }
      }
    }

    // Serializa sender-keys
    if (keys.senderKeys) {
      serialized.senderKeys = {};
      for (const [groupId, senderKeyGroup] of Object.entries(keys.senderKeys)) {
        if (senderKeyGroup && typeof senderKeyGroup === 'object') {
          serialized.senderKeys[groupId] = {};
          for (const [senderId, keyData] of Object.entries(senderKeyGroup)) {
            serialized.senderKeys[groupId][senderId] = Buffer.isBuffer(keyData) ? keyData.toString('base64') : keyData;
          }
        }
      }
    }

    // Serializa app-state-sync-keys
    if (keys.appStateSyncKeys) {
      serialized.appStateSyncKeys = {};
      for (const [keyId, keyData] of Object.entries(keys.appStateSyncKeys)) {
        if (keyData && typeof keyData === 'object') {
          serialized.appStateSyncKeys[keyId] = this.serializeAppStateSyncKey(keyData);
        }
      }
    }

    // Serializa app-state-versions
    if (keys.appStateVersions) {
      serialized.appStateVersions = { ...keys.appStateVersions };
    }

    return serialized;
  }

  /**
   * Deserializa keys do armazenamento (converte base64 para Buffers)
   */
  private deserializeKeysFromStorage(data: any): any {
    if (!data) return {};

    const keys: any = {};

    // Deserializa pre-keys
    if (data.preKeys) {
      keys.preKeys = {};
      for (const [keyId, keyData] of Object.entries(data.preKeys)) {
        if (keyData && typeof keyData === 'object') {
          keys.preKeys[keyId] = {
            keyId: (keyData as any).keyId,
            public: Buffer.from((keyData as any).public, 'base64'),
            private: Buffer.from((keyData as any).private, 'base64')
          };
        }
      }
    }

    // Deserializa sessions
    if (data.sessions) {
      keys.sessions = {};
      for (const [sessionId, sessionData] of Object.entries(data.sessions)) {
        if (sessionData) {
          keys.sessions[sessionId] = this.deserializeSessionData(sessionData);
        }
      }
    }

    // Deserializa sender-keys
    if (data.senderKeys) {
      keys.senderKeys = {};
      for (const [groupId, senderKeyGroup] of Object.entries(data.senderKeys)) {
        if (senderKeyGroup && typeof senderKeyGroup === 'object') {
          keys.senderKeys[groupId] = {};
          for (const [senderId, keyData] of Object.entries(senderKeyGroup)) {
            keys.senderKeys[groupId][senderId] = Buffer.from(keyData as string, 'base64');
          }
        }
      }
    }

    // Deserializa app-state-sync-keys
    if (data.appStateSyncKeys) {
      keys.appStateSyncKeys = {};
      for (const [keyId, keyData] of Object.entries(data.appStateSyncKeys)) {
        if (keyData) {
          keys.appStateSyncKeys[keyId] = this.deserializeAppStateSyncKey(keyData);
        }
      }
    }

    // Deserializa app-state-versions
    if (data.appStateVersions) {
      keys.appStateVersions = { ...data.appStateVersions };
    }

    return keys;
  }

  /**
   * Serializa dados de sessão específicos
   */
  private serializeSessionData(sessionData: any): any {
    if (!sessionData) return null;

    const serialized: any = { ...sessionData };

    // Converte Buffers para base64
    if (sessionData.session && Buffer.isBuffer(sessionData.session)) {
      serialized.session = sessionData.session.toString('base64');
    }

    if (sessionData.ephemeralKeyPair) {
      serialized.ephemeralKeyPair = {
        private: Buffer.isBuffer(sessionData.ephemeralKeyPair.private)
          ? sessionData.ephemeralKeyPair.private.toString('base64')
          : sessionData.ephemeralKeyPair.private,
        public: Buffer.isBuffer(sessionData.ephemeralKeyPair.public)
          ? sessionData.ephemeralKeyPair.public.toString('base64')
          : sessionData.ephemeralKeyPair.public
      };
    }

    return serialized;
  }

  /**
   * Deserializa dados de sessão específicos
   */
  private deserializeSessionData(sessionData: any): any {
    if (!sessionData) return null;

    const deserialized: any = { ...sessionData };

    // Converte base64 de volta para Buffers
    if (sessionData.session && typeof sessionData.session === 'string') {
      deserialized.session = Buffer.from(sessionData.session, 'base64');
    }

    if (sessionData.ephemeralKeyPair) {
      deserialized.ephemeralKeyPair = {
        private: typeof sessionData.ephemeralKeyPair.private === 'string'
          ? Buffer.from(sessionData.ephemeralKeyPair.private, 'base64')
          : sessionData.ephemeralKeyPair.private,
        public: typeof sessionData.ephemeralKeyPair.public === 'string'
          ? Buffer.from(sessionData.ephemeralKeyPair.public, 'base64')
          : sessionData.ephemeralKeyPair.public
      };
    }

    return deserialized;
  }

  /**
   * Serializa chaves de sincronização do app state
   */
  private serializeAppStateSyncKey(keyData: any): any {
    if (!keyData) return null;

    const serialized: any = { ...keyData };

    if (keyData.keyData && Buffer.isBuffer(keyData.keyData)) {
      serialized.keyData = keyData.keyData.toString('base64');
    }

    return serialized;
  }

  /**
   * Deserializa chaves de sincronização do app state
   */
  private deserializeAppStateSyncKey(keyData: any): any {
    if (!keyData) return null;

    const deserialized: any = { ...keyData };

    if (keyData.keyData && typeof keyData.keyData === 'string') {
      deserialized.keyData = Buffer.from(keyData.keyData, 'base64');
    }

    return deserialized;
  }

  /**
   * Remove o estado de autenticação do banco
   */
  public async removeAuthState(): Promise<void> {
    try {
      // Remove todas as chaves relacionadas
      await Promise.all([
        prisma.preKey.deleteMany({ where: { instanceId: this.instanceId } }),
        prisma.session.deleteMany({ where: { instanceId: this.instanceId } }),
        prisma.senderKey.deleteMany({ where: { instanceId: this.instanceId } }),
        prisma.appStateKey.deleteMany({ where: { instanceId: this.instanceId } }),
        prisma.appStateVersion.deleteMany({ where: { instanceId: this.instanceId } }),
        prisma.instance.delete({ where: { instanceId: this.instanceId } })
      ]);

      // Limpa o cache
      this.keysCache.clear();
      this.keysCacheLoaded = false;

      Logger.info(`🗑️ Sessão removida do banco: ${this.instanceId}`);
    } catch (error) {
      Logger.error(`❌ Erro ao remover sessão ${this.instanceId}:`, error);
    }
  }

  /**
   * Verifica se existe estado de autenticação
   */
  public async hasAuthState(): Promise<boolean> {
    try {
      const instance = await prisma.instance.findUnique({
        where: { instanceId: this.instanceId }
      });
      return !!instance;
    } catch (error) {
      Logger.error(`❌ Erro ao verificar estado de autenticação para ${this.instanceId}:`, error);
      return false;
    }
  }

  /**
   * Implementação do useMultiFileAuthState compatível com Baileys original
   * Agora usando Prisma em vez de arquivos
   */
  public async useMultiFileAuthState(instanceId: string): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
  }> {
    // Tenta carregar o authState completo primeiro
    const completeAuthState = await this.loadCompleteAuthState();

    let creds: AuthenticationCreds;
    let initialKeys: any = {};

    if (completeAuthState) {
      // Se encontrou authState completo, usa ele
      creds = completeAuthState.creds;
      initialKeys = completeAuthState.keys;
      Logger.info(`🔄 [AuthStateManager] AuthState completo carregado para: ${this.instanceId}`);
    } else {
      // Senão, carrega ou inicializa credenciais
      creds = (await this.loadCreds()) || this.initAuthCreds();
      Logger.info(`🆕 [AuthStateManager] Credenciais inicializadas para: ${this.instanceId}`);
    }

    // Função para mesclar keys do estado completo no cache
    const mergeKeysToCache = (keys: any) => {
      if (keys) {
        // Pre-keys
        if (keys.preKeys) {
          for (const [id, keyData] of Object.entries(keys.preKeys)) {
            this.keysCache.set(`pre-key:${id}`, keyData);
          }
        }

        // Sessions
        if (keys.sessions) {
          for (const [id, sessionData] of Object.entries(keys.sessions)) {
            this.keysCache.set(`session:${id}`, sessionData);
          }
        }

        // Sender keys - estrutura correta: groupId -> senderId -> keyData
        if (keys.senderKeys) {
          for (const [groupId, senderKeyGroup] of Object.entries(keys.senderKeys)) {
            if (senderKeyGroup && typeof senderKeyGroup === 'object') {
              for (const [senderId, keyData] of Object.entries(senderKeyGroup)) {
                const id = `${groupId}:${senderId}`;
                this.keysCache.set(`sender-key:${id}`, {
                  groupId,
                  senderId,
                  senderKey: Buffer.isBuffer(keyData) ? keyData : Buffer.from(keyData)
                });
              }
            }
          }
        }

        // App state sync keys
        if (keys.appStateSyncKeys) {
          for (const [id, syncKey] of Object.entries(keys.appStateSyncKeys)) {
            this.keysCache.set(`app-state-sync-key:${id}`, syncKey);
          }
        }
      }
    };

    // Carrega keys no cache se ainda não foram carregadas
    if (!this.keysCacheLoaded) {
      await this.loadKeysToCache();

      // Se temos keys do authState completo, adiciona ao cache
      if (initialKeys && Object.keys(initialKeys).length > 0) {
        mergeKeysToCache(initialKeys);
      }
    }
    const saveCompleteState = async () => {
      try {
        // Coleta todas as keys do cache
        const allKeys: any = {};
        for (const [key, value] of this.keysCache.entries()) {
          const [type, id] = key.split(':', 2);
          if (!allKeys[type]) {
            allKeys[type] = {};
          }
          allKeys[type][id] = value;
        }

        await this.saveCompleteAuthState(creds, allKeys);
        Logger.info(`💾 [AuthStateManager] Estado completo salvo para: ${this.instanceId}`);
      } catch (error) {
        Logger.error(`❌ [AuthStateManager] Erro ao salvar estado completo:`, error);
        throw error;
      }
    };

    return {
      state: {
        creds,
        keys: {
          get: async (type?: string, ids?: string[]) => {
            await this.loadKeysToCache();
            const data: { [id: string]: any } = {};

            // Se não há parâmetros, retorna todas as chaves
            if (!type && !ids) {
              const allKeys: { [id: string]: any } = {};
              for (const [key, value] of this.keysCache.entries()) {
                allKeys[key] = value;
              }
              return allKeys;
            }

            // Se só type é fornecido, retorna todas as chaves desse tipo
            if (type && !ids) {
              const typeKeys: { [id: string]: any } = {};
              for (const [key, value] of this.keysCache.entries()) {
                if (key.startsWith(`${type}:`)) {
                  const id = key.substring(type.length + 1);
                  typeKeys[id] = value;
                }
              }
              return typeKeys;
            }

            // Se ids é fornecido, busca chaves específicas
            if (ids && ids.length > 0) {
              for (const id of ids) {
                const value = this.keysCache.get(`${type}:${id}`);
                data[id] = value || null;
              }
            }

            return data;
          },
          set: async (data: { [type: string]: { [id: string]: any } }) => {
            for (const category in data) {
              for (const id in data[category]) {
                const value = data[category][id];
                if (value) {
                  this.keysCache.set(`${category}:${id}`, value);
                } else {
                  this.keysCache.delete(`${category}:${id}`);
                }
              }
            }
            await this.debouncedSaveKeys();

            // Salva o estado completo sempre que as keys são atualizadas
            await saveCompleteState();
          }
        }
      },
      saveCreds: async () => {
        await this.saveCreds(creds);
        // Também salva o estado completo
        await saveCompleteState();
      }
    };
  }

  /**
   * Inicializa credenciais seguindo exatamente o padrão Baileys
   */
  public initAuthCreds(): AuthenticationCreds {
    const identityKey = Curve.generateKeyPair();
    return {
      noiseKey: Curve.generateKeyPair(),
      pairingEphemeralKeyPair: Curve.generateKeyPair(),
      signedIdentityKey: identityKey,
      signedPreKey: this.generateSignedKeyPair(identityKey, 1),
      registrationId: this.generateRegistrationId(),
      advSecretKey: randomBytes(32).toString('base64'),
      processedHistoryMessages: [],
      nextPreKeyId: 1,
      firstUnuploadedPreKeyId: 1,
      accountSyncCounter: 0,
      accountSettings: {
        unarchiveChats: false
      },
      registered: false,
      pairingCode: undefined,
      lastPropHash: undefined,
      routingInfo: undefined,
      serverHasPreKeys: false
    };
  }

  /**
   * Cria estado de autenticação compatível com Baileys
   * Seguindo exatamente o padrão Baileys com persistência automática
   * @param existingState Estado existente opcional para usar em vez de carregar do banco
   */
  public async createBaileysCompatibleAuthState(existingState?: AuthenticationState): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
  }> {
    let state: AuthenticationState;

    if (existingState) {
      // Usa estado existente fornecido (padrão Baileys para reconexão)
      state = existingState;
      Logger.info(`🔄 Estado de autenticação fornecido usado para: ${this.instanceId}`);
    } else {
      // Tenta carregar estado existente do banco primeiro (padrão Baileys)
      const existing = await this.loadAuthState();

      if (existing) {
        state = existing;
        Logger.info(`🔄 Estado de autenticação carregado do banco para: ${this.instanceId}`);
      } else {
        // Inicializa novo estado se não existir
        state = await this.initAuthState();
        Logger.info(`🆕 Novo estado de autenticação inicializado para: ${this.instanceId}`);
      }
    }

    // Função saveCreds que persiste automaticamente seguindo padrão Baileys
    const saveCreds = async () => {
      try {
        // Salva credenciais no banco (persistência automática)
        await this.saveCreds(state.creds);

        // Salva também o estado completo para garantir consistência
        await this.saveSessionToDB(this.instanceId, state);

        Logger.debug(`💾 Credenciais persistidas automaticamente para: ${this.instanceId}`);
      } catch (error) {
        Logger.error(`❌ Erro ao persistir credenciais automaticamente:`, error);
        throw error;
      }
    };

    return { state, saveCreds };
  }

  /**
   * Atualiza credenciais parcialmente
   */
  public async updateCreds(credsUpdate: Partial<AuthenticationCreds>): Promise<void> {
    const existing = await this.loadCreds();
    if (!existing) return;
    const updated = { ...existing, ...credsUpdate } as AuthenticationCreds;
    await this.saveCreds(updated);
  }

  /**
   * Marca uma pre-key como usada no banco de dados
   * E periodicamente limpa preKeys usadas (a cada 10 preKeys marcadas)
   */
  public async markPreKeyAsUsed(keyId: number): Promise<void> {
    try {
      await prisma.preKey.updateMany({
        where: {
          instanceId: this.instanceId,
          keyId: keyId
        },
        data: {
          used: true
        }
      });

      Logger.debug(`🗑️ Pre-key ${keyId} marcada como usada no banco`);

      // Contador estático para controlar quando limpar preKeys usadas
      if (!(this as any).preKeyCleanupCounter) {
        (this as any).preKeyCleanupCounter = 0;
      }

      // Incrementa contador e limpa a cada 10 preKeys marcadas
      (this as any).preKeyCleanupCounter++;
      if ((this as any).preKeyCleanupCounter >= 10) {
        (this as any).preKeyCleanupCounter = 0;
        // Executa limpeza em background para não bloquear o fluxo principal
        this.cleanupUsedPreKeys().catch(err =>
          Logger.warn(`⚠️ Erro na limpeza automática de preKeys: ${err instanceof Error ? err.message : String(err)}`)
        );
        Logger.info(`🧹 Iniciada limpeza automática de preKeys usadas`);
      }
    } catch (error) {
      Logger.error(`❌ Erro ao marcar pre-key ${keyId} como usada:`, error);
      throw error;
    }
  }

  /**
   * Atualiza o nextPreKeyId nas credenciais
   */
  public async updateNextPreKeyId(nextId: number): Promise<void> {
    try {
      await this.updateCreds({ nextPreKeyId: nextId });
      Logger.debug(`🔄 NextPreKeyId atualizado para: ${nextId}`);
    } catch (error) {
      Logger.error(`❌ Erro ao atualizar nextPreKeyId:`, error);
      throw error;
    }
  }

  /**
   * Remove pre-keys usadas do banco de dados
   */
  public async cleanupUsedPreKeys(): Promise<void> {
    try {
      const result = await prisma.preKey.deleteMany({
        where: {
          instanceId: this.instanceId,
          used: true
        }
      });

      Logger.debug(`🧹 ${result.count} pre-keys usadas removidas do banco`);
    } catch (error) {
      Logger.error(`❌ Erro ao limpar pre-keys usadas:`, error);
      throw error;
    }
  }

  /**
   * Conta pre-keys disponíveis no banco
   */
  public async countAvailablePreKeys(): Promise<number> {
    try {
      const count = await prisma.preKey.count({
        where: {
          instanceId: this.instanceId,
          used: false
        }
      });

      return count;
    } catch (error) {
      Logger.error(`❌ Erro ao contar pre-keys disponíveis:`, error);
      return 0;
    }
  }
}