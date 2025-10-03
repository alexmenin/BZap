// SignalProtocolStore.ts - Store compatível com libsignal para gerenciar sessions, pre-keys e identities
// Implementação alinhada ao comportamento esperado do cliente, usando libsignal nativo

import { SignalKeyStore } from '../auth/AuthStateManager';
import { Logger } from '../utils/Logger';
import { ensureBuffer } from '../utils/BufferUtils';
import { prisma } from '../database/PrismaClient';
import { parseAddressName, jidToSignalAddress } from '../utils/SignalUtils';
import { generateSignalPubKey } from './Curve25519';

const libsignal = require('libsignal');

/**
 * Interface para endereço do protocolo Signal
 */
export interface SignalProtocolAddress {
  name: string;
  deviceId: number;
}

/**
 * Interface para bundle de pre-key
 */
export interface PreKeyBundle {
  registrationId: number;
  deviceId: number;
  preKeyId?: number;
  preKeyPublic?: Buffer;
  signedPreKeyId: number;
  signedPreKeyPublic: Buffer;
  signedPreKeySignature: Buffer;
  identityKey: Buffer;
}

/**
 * SignalProtocolStore compatível com libsignal
 * Implementa todas as interfaces necessárias para SessionBuilder e SessionCipher
 */
export class SignalProtocolStore {
  private keyStore: SignalKeyStore;
  private identityKeyPair: { pubKey: Buffer; privKey: Buffer };
  private registrationId: number;
  private authCreds: any; // Credenciais de autenticação para acessar signedPreKey
  private companionKey?: Buffer; // ✅ NOVA PROPRIEDADE: companion_enc_static
  private instanceId?: string; // ✅ Escopo da instância para persistência Prisma
  public authState?: any; // Referência ao AuthStateManager para persistência

  constructor(keyStore: SignalKeyStore, identityKeyPair: any, registrationId: number, authCreds?: any, instanceId?: string, authState?: any) {
    this.keyStore = keyStore;
    this.identityKeyPair = identityKeyPair;
    this.registrationId = registrationId;
    this.authCreds = authCreds;
    this.instanceId = instanceId ?? (keyStore as any)?.instanceId;
    this.authState = authState;
    // ✅ Inicializa companion key se disponível nas credenciais
    if (authCreds?.companionKey) {
      this.companionKey = authCreds.companionKey;
      Logger.info('🔑 SignalProtocolStore inicializado com companion_enc_static');
    }
    if (!this.instanceId) {
      Logger.warn('⚠️ SignalProtocolStore inicializado sem instanceId. Upserts Prisma serão ignorados.');
    }
  }

  /**
   * ✅ NOVO MÉTODO: Atualiza companion_enc_static no store
   */
  updateCompanionKey(companionKey: Buffer): void {
    this.companionKey = companionKey;
    Logger.info('🔑 companion_enc_static atualizado no SignalProtocolStore');
  }

  /**
   * ✅ NOVO MÉTODO: Obtém companion_enc_static
   */
  getCompanionKey(): Buffer | undefined {
    return this.companionKey;
  }

  /**
   * Obtém par de chaves de identidade
   */
  getIdentityKeyPair(): Promise<{ pubKey: Buffer; privKey: Buffer }> {
    return Promise.resolve(this.identityKeyPair);
  }

  /**
   * Obtém ID de registro local
   */
  getLocalRegistrationId(): Promise<number> {
    return Promise.resolve(this.registrationId);
  }

  // Helper para normalizar endereço vindo do libsignal ou objeto literal
  private resolveAddress(address: any): SignalProtocolAddress {
    try {
      // libsignal.ProtocolAddress possui getName/getDeviceId
      if (address && typeof address.getName === 'function') {
        const name = address.getName();
        const deviceId = typeof address.getDeviceId === 'function' ? address.getDeviceId() : 0;
        const parsed = jidToSignalAddress(name);
        // Se libsignal trouxe deviceId separado, ele tem precedência
        return { name: parsed.name, deviceId: deviceId ?? parsed.deviceId ?? 0 };
      }
      // Objeto literal { name, deviceId }
      if (address && typeof address.name === 'string') {
        const deviceId = typeof address.deviceId === 'number' ? address.deviceId : 0;
        const parsed = jidToSignalAddress(address.name);
        return { name: parsed.name, deviceId: deviceId ?? parsed.deviceId ?? 0 };
      }
      // String JID ou addressName (ex: "551699...@s.whatsapp.net" ou "551699....37")
      if (typeof address === 'string') {
        const raw = address.trim();
        const parsed = jidToSignalAddress(raw);
        // Aplica sufixo _1 para LID
        const server = raw.split('@')[1];
        const name = server === 'lid' && !parsed.name.endsWith('_1') ? `${parsed.name}_1` : parsed.name;
        return { name, deviceId: parsed.deviceId ?? 0 };
      }
    } catch {}
    Logger.error(`❌ [SIGNAL_FLOW] resolveAddress - Endereço inválido: ${JSON.stringify(address)}`);
    return { name: '', deviceId: 0 };
  }

  /**
   * Salva identidade do contato
   */
  async saveIdentity(address: SignalProtocolAddress, identityKey: Buffer): Promise<boolean> {
    // Usamos apenas o JID como chave, sem concatenar com o device
    const { name: jid, deviceId } = this.resolveAddress(address);

    try {
      // Carrega identidades existentes
      const existingIdentities = await this.keyStore.get('identity', [jid]);
      const existingIdentity = existingIdentities[jid];

      if (existingIdentity) {
        // Verifica se a identidade mudou
        const existingKey = Buffer.from(existingIdentity.identityKey);
        if (!identityKey.equals(existingKey)) {
          Logger.warn(`🔑 Identidade mudou para ${jid} (device: ${deviceId})`);
          // Salva nova identidade
          await this.keyStore.set({
            'identity': {
              [jid]: {
                identityKey: identityKey,
                timestamp: Date.now()
              }
            }
          });
          return false; // Identidade mudou
        }
        return true; // Identidade já existe e é a mesma
      }

      // Salva nova identidade
      await this.keyStore.set({
        'identity': {
          [jid]: {
            identityKey: identityKey,
            timestamp: Date.now()
          }
        }
      });

      Logger.info(`🔑 Nova identidade salva para ${jid} (device: ${deviceId})`);
      return true;
    } catch (error) {
      Logger.error('❌ Erro ao salvar identidade:', error);
      throw error;
    }
  }

  /**
   * ✅ NOVO MÉTODO: Carrega identidade do contato
   */
  async loadIdentity(address: SignalProtocolAddress): Promise<Buffer | null> {
    // Não concatenamos mais o jid com o device, usamos apenas o jid como chave
    const { name: jid, deviceId } = this.resolveAddress(address);
    try {
      const identities = await this.keyStore.get('identity', [jid]);
      const stored = identities[jid];
      if (!stored) return null;
      const buf = ensureBuffer(stored.identityKey);
      Logger.debug(`🔑 Identidade carregada para ${jid} (device: ${deviceId}) (${buf.length} bytes)`);
      return buf;
    } catch (error) {
      Logger.error(`❌ Erro ao carregar identidade para ${jid}:`, error);
      return null;
    }
  }

  /**
   * ✅ NOVO MÉTODO: Armazena/atualiza identidade do contato
   */
  async storeIdentity(address: SignalProtocolAddress, identityKey: Buffer): Promise<void> {
    const { name: jid } = this.resolveAddress(address); // só o jid puro
    try {
      await this.keyStore.set({
        'identity': {
          [jid]: {
            identityKey,
            timestamp: Date.now()
          }
        }
      });
      Logger.info(`🔄 [SIGNAL_FLOW] storeIdentity - Identidade salva/atualizada para ${jid}`);

      if (process.env.VERBOSE_SIGNAL_LOG === 'true') {
        Logger.debug(`🔍 [SIGNAL_DETAIL] storeIdentity - Address: ${jid}`);
        Logger.debug(`🔍 [SIGNAL_DETAIL] storeIdentity - IdentityKey length: ${identityKey.length} bytes`);
        Logger.debug(`🔍 [SIGNAL_DETAIL] storeIdentity - IdentityKey (base64): ${identityKey.toString('base64').substring(0, 15)}...`);
      }

      // 💾 Persistência direta via Prisma
      if (this.instanceId) {
        try {
          const identityKeyBase64 = Buffer.from(identityKey).toString('base64');
          const result = await prisma.identity.upsert({
            where: {
              instanceId_jid: {
                instanceId: this.instanceId,
                jid
              }
            },
            update: { identityKey: identityKeyBase64, updatedAt: new Date() },
            create: { instanceId: this.instanceId, jid, identityKey: identityKeyBase64, trustLevel: 0, updatedAt: new Date() }
          });
          Logger.info(`✅ [SIGNAL_FLOW] Identity persistida no banco para ${jid}`);
        } catch (dbErr) {
          Logger.error(`❌ [SIGNAL_FLOW] Erro ao persistir identidade no banco para ${jid}:`, dbErr);
        }
      } else {
        Logger.debug('ℹ️ instanceId ausente; pulando upsert de identity no Prisma');
      }
    } catch (error) {
      Logger.error(`❌ Erro ao salvar identidade para ${jid}:`, error);
      throw error;
    }
  }

  /**
   * Verifica se identidade é confiável
   */
  async isTrustedIdentity(address: SignalProtocolAddress, identityKey: Buffer): Promise<boolean> {
    const { name: jid, deviceId } = this.resolveAddress(address); // não concatena com device

    try {
      const identities = await this.keyStore.get('identity', [jid]);
      const storedIdentity = identities[jid];

      if (!storedIdentity) {
        // Trust-On-First-Use: se não há identidade armazenada, confiar
        if (process.env.VERBOSE_SIGNAL_LOG === 'true') {
          Logger.debug(`🔐 [SIGNAL_FLOW] isTrustedIdentity - TOFU: nenhuma identidade para ${jid}, confiando na recebida (device: ${deviceId})`);
        }
        return true;
      }

      // Compara com identidade armazenada
      const storedKey = ensureBuffer(storedIdentity.identityKey);
      const equals = identityKey.equals(storedKey);
      if (!equals) {
        // Adotar TOFU: permitir atualização da identidade ao detectar mudança
        Logger.warn(`⚠️ [SIGNAL_FLOW] isTrustedIdentity - Identidade diferente para ${jid} (device: ${deviceId}). Permitindo atualização (TOFU).`);
        return true;
      }
      return true;
    } catch (error) {
      // Em caso de erro de leitura, não bloquear a sessão
      Logger.warn('⚠️ [SIGNAL_FLOW] isTrustedIdentity - Erro ao verificar identidade; confiando por segurança (TOFU).', error);
      return true;
    }
  }

  /**
   * Carrega pre-key
   */
  async loadPreKey(keyId: number): Promise<{ pubKey: Buffer; privKey: Buffer } | null> {
    try {
      Logger.info(`🔄 [SIGNAL_FLOW] loadPreKey - Buscando preKey ${keyId}`);
      const preKeys = await this.keyStore.get('pre-key', [keyId.toString()]);
      const preKey = preKeys[keyId.toString()];

      if (!preKey) {
        Logger.info(`🔄 [SIGNAL_FLOW] loadPreKey - preKey ${keyId} não encontrada`);
        return undefined as any; // alinhado ao contrato do libsignal
      }

      Logger.info(`✅ [SIGNAL_FLOW] loadPreKey - preKey ${keyId} encontrada e carregada`);

      if (process.env.VERBOSE_SIGNAL_LOG === 'true') {
        Logger.debug(`🔍 [SIGNAL_DETAIL] loadPreKey - KeyID: ${keyId}`);
        Logger.debug(`🔍 [SIGNAL_DETAIL] loadPreKey - PubKey length: ${preKey.public.length} bytes`);
      }

      return {
        pubKey: ensureBuffer(preKey.public),
        privKey: ensureBuffer(preKey.private)
      };
    } catch (error) {
      Logger.error(`❌ [SIGNAL_FLOW] Erro ao carregar pre-key ${keyId}:`, error);
      return null;
    }
  }

  /**
   * Remove pre-key
   */
  async removePreKey(keyId: number): Promise<void> {
    try {
      Logger.info(`🔄 [SIGNAL_FLOW] removePreKey - Removendo preKey ${keyId}`);

      // Marca pre-key como removida (não remove fisicamente para debug)
      await this.keyStore.set({
        'pre-key': {
          [keyId.toString()]: null
        }
      });

      // Se o keyStore suportar marcação de uso no banco, utilize
      const maybeMarkUsed = (this.keyStore as any)?.markPreKeyAsUsed;
      if (typeof maybeMarkUsed === 'function') {
        try {
          await maybeMarkUsed.call(this.keyStore, keyId);
          Logger.debug(`🗑️ Pre-key ${keyId} marcada como usada no banco via keyStore`);
        } catch (e) {
          Logger.warn(`⚠️ Falha ao marcar pre-key ${keyId} como usada no banco: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Marca como usada no Prisma (used=true, usedAt=now), alinhado a Baileys/WhatsMeow
      if (this.instanceId) {
        try {
          const res = await prisma.preKey.updateMany({
            where: {
              instanceId: this.instanceId,
              keyId: keyId
            },
            data: {
              used: true,
              usedAt: new Date()
            }
          });
          if (res.count > 0) {
            Logger.debug(`🗓️ Pre-key ${keyId} marcada como usada no Prisma (instanceId=${this.instanceId})`);
          } else {
            Logger.warn(`⚠️ Pre-key ${keyId} não encontrada para marcar como usada (instanceId=${this.instanceId})`);
          }
        } catch (dbErr) {
          Logger.warn(`⚠️ Não foi possível marcar pre-key ${keyId} como usada no Prisma: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
        }
      }
      Logger.info(`🗑️ Pre-key ${keyId} removida`);
    } catch (error) {
      Logger.error(`❌ Erro ao remover pre-key ${keyId}:`, error);
    }
  }

  /**
   * ✅ NOVOS MÉTODOS: Sender Keys (grupos)
   */
  async loadSenderKey(groupId: string, senderId: string): Promise<Buffer | null> {
    const id = `${groupId}:${senderId}`;
    try {
      const keys = await this.keyStore.get('sender-key', [id]);
      const stored = keys[id];
      if (!stored) return null;
      const buf = ensureBuffer(stored.senderKey);
      Logger.debug(`🔄 SenderKey carregada ${groupId}:${senderId} (${buf.length} bytes)`);
      return buf;
    } catch (error) {
      Logger.error(`❌ Erro ao carregar sender key ${groupId}:${senderId}:`, error);
      return null;
    }
  }

  async storeSenderKey(groupId: string, senderId: string, senderKey: Buffer): Promise<void> {
    const id = `${groupId}:${senderId}`;
    try {
      await this.keyStore.set({
        'sender-key': {
          [id]: { groupId, senderId, senderKey }
        }
      });
      Logger.info(`💾 SenderKey salva ${groupId}:${senderId}`);
    } catch (error) {
      Logger.error(`❌ Erro ao salvar sender key ${groupId}:${senderId}:`, error);
      throw error;
    }
  }

  /**
   * Obtém nossa identidade
   */
  getOurIdentity(): Promise<{ pubKey: Buffer; privKey: Buffer }> {
    try {
      if (!this.authCreds || !this.authCreds.signedIdentityKey) {
        Logger.error('❌ SignedIdentityKey não encontrada nas credenciais');
        throw new Error('SignedIdentityKey não encontrada nas credenciais');
      }

      const { signedIdentityKey } = this.authCreds;

      return Promise.resolve({
        privKey: ensureBuffer(signedIdentityKey.private),
        pubKey: ensureBuffer(generateSignalPubKey(signedIdentityKey.public))
      });
    } catch (error) {
      Logger.error('❌ Erro ao obter nossa identidade:', error);
      throw error;
    }
  }

  /**
   * Carrega signed pre-key
   */
  async loadSignedPreKey(): Promise<{ pubKey: Buffer; privKey: Buffer } | null> {
    try {
      Logger.debug(`🔍 Carregando SignedPreKey das credenciais`);

      // Recupera diretamente das credenciais sem usar keyId
      if (!this.authCreds || !this.authCreds.signedPreKey) {
        Logger.error(`❌ SignedPreKey não encontrada nas credenciais`);
        return null;
      }

      const signedPreKey = this.authCreds.signedPreKey;

      Logger.debug(`✅ SignedPreKey carregada com sucesso - ID: ${signedPreKey.keyId}`);

      return {
        privKey: ensureBuffer(signedPreKey.keyPair.private),
        pubKey: ensureBuffer(signedPreKey.keyPair.public)
      };
    } catch (error) {
      Logger.error('❌ Erro ao carregar SignedPreKey:', error);
      return null;
    }
  }

  /**
   * Carrega session
   */
  async loadSession(address: SignalProtocolAddress): Promise<any | null> {
    // Usamos apenas o JID como chave primária, com device como campo separado
    const { name: jid, deviceId: device } = this.resolveAddress(address);
    // ⚠️ Usamos uma chave única para o cache interno, mas mantemos jid e device separados
    const cacheKey = `${jid}:${device}`;

    try {
      // Validação de segurança para evitar undefined.undefined
      if (!jid || device === undefined) {
        Logger.error(`❌ [SIGNAL_FLOW] loadSession - Endereço inválido: name=${jid}, deviceId=${device}`);
        return null;
      }

      // Tenta buscar do cache usando a nova chave formatada
      const sessions = await this.keyStore.get('session', [cacheKey]);
      let session = sessions[cacheKey];

      // Fallback: tentar chave antiga usando separador '.'
      if (!session) {
        const legacyKey = `${jid}.${device}`;
        const legacySessions = await this.keyStore.get('session', [legacyKey]);
        const legacySession = legacySessions[legacyKey];
        if (legacySession) {
          Logger.info(`♻️ [SIGNAL_FLOW] loadSession - Compatibilidade: sessão encontrada com chave antiga '${legacyKey}' para ${jid} (device: ${device})`);
          session = legacySession;
          // Migra para chave nova no cache
          await this.keyStore.set({
            'session': {
              [cacheKey]: legacySession
            }
          });
        }
      }

      if (!session) {
        Logger.info(`🔄 [SIGNAL_FLOW] loadSession - Nenhuma session encontrada no cache para ${jid} (device: ${device})`);

        // Tenta buscar do banco de dados se não estiver no cache
        if (this.instanceId) {
          try {
            const dbSession = await prisma.session.findUnique({
              where: {
                instanceId_jid_device: {
                  instanceId: this.instanceId,
                  jid: jid,
                  device: device
                }
              }
            });

            if (dbSession) {
              Logger.info(`✅ [SIGNAL_FLOW] Session recuperada do banco para ${jid} (device: ${device})`);

              // Adiciona ao cache com o novo formato de chave
              await this.keyStore.set({
                'session': {
                  [cacheKey]: {
                    id: cacheKey,
                    jid: jid,
                    device: device,
                    session: dbSession.record
                  }
                }
              });

              // Constrói SessionRecord suportando JSON e bytes
              const rec = dbSession.record as any;
              try {
                if (rec && typeof rec === 'object') {
                  if (rec.__type === 'bytes' && typeof rec.base64 === 'string') {
                    const buf = Buffer.from(rec.base64, 'base64');
                    return libsignal.SessionRecord.deserialize(buf);
                  }
                  if (rec.__type === 'string' && typeof rec.utf8 === 'string') {
                    const buf = Buffer.from(rec.utf8, 'utf-8');
                    return libsignal.SessionRecord.deserialize(buf);
                  }
                  if (rec.type === 'Buffer' && Array.isArray(rec.data)) {
                    const buf = Buffer.from(rec.data);
                    return libsignal.SessionRecord.deserialize(buf);
                  }
                  return new libsignal.SessionRecord(rec);
                }
                if (typeof rec === 'string') {
                  const buf = Buffer.from(rec, 'utf-8');
                  return libsignal.SessionRecord.deserialize(buf);
                }
                return libsignal.SessionRecord.deserialize(ensureBuffer(rec));
              } catch (e) {
                Logger.error('❌ [SIGNAL_FLOW] Falha ao construir SessionRecord a partir do banco:', e);
              }
            }
          } catch (dbErr) {
            Logger.error(`❌ [SIGNAL_FLOW] Erro ao buscar session no banco para ${jid} (device: ${device}):`, dbErr);
          }
        }

        return null;
      }

      // Log amigável independente do formato
      const sessVal: any = session.session;
      const len = Buffer.isBuffer(sessVal)
        ? sessVal.length
        : typeof sessVal === 'string'
          ? Buffer.byteLength(sessVal, 'utf-8')
          : (sessVal && typeof sessVal === 'object' && sessVal.__type === 'bytes' && typeof sessVal.base64 === 'string')
            ? Buffer.byteLength(sessVal.base64, 'base64')
            : undefined;
      Logger.info(`🔄 [SIGNAL_FLOW] loadSession - Session encontrada para ${jid} (device: ${device})${len !== undefined ? ` (~${len} bytes)` : ''}`);

      if (process.env.VERBOSE_SIGNAL_LOG === 'true') {
        Logger.debug(`🔍 [SIGNAL_DETAIL] loadSession - Address: ${jid} (device: ${device})`);
        Logger.debug(`🔍 [SIGNAL_DETAIL] loadSession - Cache key: ${cacheKey}`);
        Logger.debug(`🔍 [SIGNAL_DETAIL] loadSession - Session type: ${typeof session.session}`);
        Logger.debug(`🔍 [SIGNAL_DETAIL] loadSession - Is Buffer: ${Buffer.isBuffer(session.session)}`);
      }

      // Retorna SessionRecord do libsignal com robustez ao formato (cache)
      const cacheRec = session.session as any;
      try {
        if (cacheRec && typeof cacheRec === 'object') {
          if (cacheRec.__type === 'bytes' && typeof cacheRec.base64 === 'string') {
            const buf = Buffer.from(cacheRec.base64, 'base64');
            return libsignal.SessionRecord.deserialize(buf);
          }
          if (cacheRec.__type === 'string' && typeof cacheRec.utf8 === 'string') {
            const buf = Buffer.from(cacheRec.utf8, 'utf-8');
            return libsignal.SessionRecord.deserialize(buf);
          }
          if (cacheRec.type === 'Buffer' && Array.isArray(cacheRec.data)) {
            const buf = Buffer.from(cacheRec.data);
            return libsignal.SessionRecord.deserialize(buf);
          }
          return new libsignal.SessionRecord(cacheRec);
        }
        if (typeof cacheRec === 'string') {
          const buf = Buffer.from(cacheRec, 'utf-8');
          return libsignal.SessionRecord.deserialize(buf);
        }
        return libsignal.SessionRecord.deserialize(ensureBuffer(cacheRec));
      } catch (e) {
        Logger.error('❌ [SIGNAL_FLOW] Falha ao construir SessionRecord a partir do cache:', e);
        return null;
      }
    } catch (error) {
      Logger.error(`❌ [SIGNAL_FLOW] Erro ao carregar session para ${jid} (device: ${device}):`, error);
      return null;
    }
  }

  /**
   * Salva sessão de criptografia
   */
  async storeSession(address: SignalProtocolAddress, record: any): Promise<void> {
    // Usamos apenas o JID como chave primária, com device como campo separado
    const { name: jid, deviceId: device } = this.resolveAddress(address);
    // ⚠️ Usamos uma chave única para o cache interno, mas mantemos jid e device separados
    const cacheKey = `${jid}:${device}`;

    try {
      // 🔧 Captura o resultado de record.serialize() e prepara para armazenamento JSON
      const serialized = record.serialize();
      let persistable: any = undefined;
      if (Buffer.isBuffer(serialized)) {
        persistable = { __type: 'bytes', base64: serialized.toString('base64') };
      } else if (serialized instanceof Uint8Array) {
        persistable = { __type: 'bytes', base64: Buffer.from(serialized).toString('base64') };
      } else if (serialized instanceof ArrayBuffer) {
        persistable = { __type: 'bytes', base64: Buffer.from(new Uint8Array(serialized)).toString('base64') };
      } else if (Array.isArray(serialized)) {
        persistable = { __type: 'bytes', base64: Buffer.from(serialized).toString('base64') };
      } else if (typeof serialized === 'string') {
        // Podemos armazenar string diretamente, mas padronizamos com marcador
        persistable = { __type: 'string', utf8: serialized };
      } else if (serialized && typeof serialized === 'object') {
        // Armazenamos o objeto JSON-like diretamente
        persistable = serialized;
      } else {
        throw new TypeError('Unsupported session serialize format');
      }

      if (process.env.VERBOSE_SIGNAL_LOG === 'true') {
        Logger.debug(`🔍 [SIGNAL_DETAIL] storeSession - Address: ${jid} (device: ${device})`);
        Logger.debug(`🔍 [SIGNAL_DETAIL] storeSession - Cache key: ${cacheKey}`);
        Logger.debug(`🔍 [SIGNAL_DETAIL] storeSession - Record type: ${typeof record}`);
        Logger.debug(`🔍 [SIGNAL_DETAIL] storeSession - Persistable shape: ${typeof persistable === 'object' ? JSON.stringify(Object.keys(persistable)) : typeof persistable}`);
      }

      Logger.info(`🔄 [SIGNAL_FLOW] storeSession chamado para ${jid} (device: ${device})`);

      // Armazenamos no cache usando a chave formatada
      const sessionData = {
        'session': {
          [cacheKey]: {
            id: cacheKey,
            jid: jid,
            device: device,
            session: persistable
          }
        }
      };

      await this.keyStore.set(sessionData);
      // Compatibilidade: manter também com chave antiga usando '.' por um tempo
      await this.keyStore.set({
        'session': {
          [`${jid}.${device}`]: sessionData['session'][cacheKey]
        }
      });

      // Persistência no banco de dados (JSON)
      if (this.instanceId) {
        try {
          await prisma.session.upsert({
            where: {
              instanceId_jid_device: {
                instanceId: this.instanceId,
                jid: jid,
                device: device
              }
            },
            update: {
              updatedAt: new Date(),
              record: persistable
            },
            create: {
              instanceId: this.instanceId,
              jid: jid,
              device: device,
              record: persistable,
              createdAt: new Date(),
              updatedAt: new Date()
            }
          });

          Logger.info(`✅ [SIGNAL_FLOW] Sessão persistida no banco para ${jid} (device: ${device})`);
        } catch (dbErr) {
          Logger.error(`❌ [SIGNAL_FLOW] Erro ao persistir sessão no banco para ${jid} (device: ${device}):`, dbErr);
        }
      } else {
        Logger.debug('ℹ️ instanceId ausente; pulando upsert de sessão no Prisma');
      }
    } catch (error) {
      Logger.error(`❌ Erro ao salvar sessão para ${jid} (device: ${device}):`, error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      if (errorStack) {
        Logger.error(`🔥 [DEBUG] storeSession FALHOU:`, errorStack);
      }
      throw error;
    }
  }

  /**
   * Verifica se session existe
   */
  async containsSession(address: SignalProtocolAddress): Promise<boolean> {
    const { name: jid, deviceId: device } = this.resolveAddress(address);
    const cacheKey = `${jid}:${device}`;

    try {
      const sessions = await this.keyStore.get('session', [cacheKey]);
      let hasSession = !!sessions[cacheKey];
      if (!hasSession) {
        const legacyKey = `${jid}.${device}`;
        const legacySessions = await this.keyStore.get('session', [legacyKey]);
        hasSession = !!legacySessions[legacyKey];
      }

      Logger.debug(`🔍 Session existe para ${jid} (device: ${device}): ${hasSession}`);
      return hasSession;
    } catch (error) {
      Logger.error(`❌ Erro ao verificar session para ${jid} (device: ${device}):`, error);
      return false;
    }
  }

  /**
   * Obtém sub device sessions
   */
  async getSubDeviceSessions(name: string): Promise<number[]> {
    try {
      const allSessions = await this.keyStore.get('session');
      const deviceIds: number[] = [];

      for (const sessionId of Object.keys(allSessions)) {
        if (sessionId.startsWith(`${name}:`)) {
          const deviceId = parseInt(sessionId.split(':')[1]);
          if (!isNaN(deviceId)) {
            deviceIds.push(deviceId);
          }
        }
      }

      Logger.debug(`📱 Sub devices para ${name}: [${deviceIds.join(', ')}]`);
      return deviceIds;
    } catch (error) {
      Logger.error(`❌ Erro ao obter sub device sessions para ${name}:`, error);
      return [];
    }
  }

  /**
   * Remove session
   */
  async deleteSession(address: SignalProtocolAddress): Promise<void> {
    const { name: jid, deviceId: device } = this.resolveAddress(address);
    const cacheKey = `${jid}:${device}`;

    try {
      await this.keyStore.set({
        'session': {
          [cacheKey]: null
        }
      });

      Logger.info(`🗑️ Session removida para ${jid} (device: ${device})`);

      // 💾 Remoção direta no banco
      if (this.instanceId) {
        try {
          await prisma.session.delete({
            where: {
              instanceId_jid_device: {
                instanceId: this.instanceId,
                jid: jid,
                device: device
              }
            }
          });
          Logger.debug(`🗑️ [DB] Session removida no banco: ${this.instanceId}:${jid} (device: ${device})`);
        } catch (dbErr) {
          Logger.warn(`⚠️ Falha ao remover session no banco (pode não existir): ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
        }
      }
    } catch (error) {
      Logger.error(`❌ Erro ao remover session para ${jid} (device: ${device}):`, error);
    }
  }

  /**
   * Remove todas as sessions
   */
  async deleteAllSessions(name: string): Promise<void> {
    try {
      const allSessions = await this.keyStore.get('session');
      const sessionsToDelete: { [key: string]: null } = {};

      for (const sessionId of Object.keys(allSessions)) {
        if (sessionId.startsWith(`${name}:`)) {
          sessionsToDelete[sessionId] = null;
        }
      }

      if (Object.keys(sessionsToDelete).length > 0) {
        await this.keyStore.set({
          'session': sessionsToDelete
        });

        Logger.info(`🗑️ ${Object.keys(sessionsToDelete).length} sessions removidas para ${name}`);

        // 💾 Remoção direta no banco (todas as sessions para o name)
        if (this.instanceId) {
          try {
            // Busca devices conhecidos para o name e remove cada uma
            const deviceIds = await this.getSubDeviceSessions(name);
            await Promise.all(
              deviceIds.map((deviceId) =>
                prisma.session.delete({
                  where: {
                    instanceId_jid_device: {
                      instanceId: this.instanceId!,
                      jid: name,
                      device: deviceId
                    }
                  }
                }).catch(() => null)
              )
            );
            Logger.debug(`🗑️ [DB] Sessions removidas no banco para ${this.instanceId}:${name}`);
          } catch (dbErr) {
            Logger.warn(`⚠️ Falha ao remover sessions no banco para ${name}: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
          }
        }
      }
    } catch (error) {
      Logger.error(`❌ Erro ao remover todas as sessions para ${name}:`, error);
    }
  }

  // Getter público para acessar o keyStore
  public getKeyStore(): SignalKeyStore {
    return this.keyStore;
  }
}

/**
 * Cria endereço do protocolo Signal
 */
export function createSignalProtocolAddress(jid: string): SignalProtocolAddress {
  // Parser robusto do JID para extrair name, deviceId e aplicar regra LID (_1)
  // 551699…@s.whatsapp.net        -> name: 551699…, deviceId: 0
  // 551699…:37@s.whatsapp.net     -> name: 551699…, deviceId: 37
  // 274143…:87@lid                -> name: 274143…_1, deviceId: 87
  const [userPart, server] = jid.split('@');
  let name = userPart;
  let deviceId = 0;

  if (userPart.includes(':')) {
    const [base, devStr] = userPart.split(':');
    name = base;
    deviceId = parseInt(devStr, 10) || 0;
  } else if (userPart.includes('.')) {
    const parts = userPart.split('.');
    const last = parts[parts.length - 1];
    if (!isNaN(parseInt(last, 10))) {
      deviceId = parseInt(last, 10) || 0;
      name = parts.slice(0, -1).join('.');
    }
  }

  // Regra LID: adicionar sufixo _1 ao user para endereços Signal
  if (server === 'lid' && !name.endsWith('_1')) {
    name = `${name}_1`;
  }

  return { name, deviceId };
}

/**
 * Converte endereço para string
 */
export function addressToString(address: SignalProtocolAddress): string {
  return `${address.name}:${address.deviceId}`; // antes era "." → troca para ":"
}
