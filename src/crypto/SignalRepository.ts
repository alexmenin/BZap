// SignalRepository.ts - Implementação do padrão repository.decryptMessage 

const libsignal = require('libsignal');
import { SignalProtocolStore } from './SignalProtocolStore';
import { createSignalProtocolAddress, parseDeviceFromJid } from '../utils/SignalUtils';
import { AuthenticationCreds, SignalKeyStore } from '../auth/AuthStateManager';
import { prisma } from '../database/PrismaClient';
import { Logger } from '../utils/Logger';
import { ensureBuffer } from '../utils/BufferUtils';
import { generateSignalPubKey } from './Curve25519';

const VERBOSE_SIGNAL_LOG = process.env.VERBOSE_SIGNAL_LOG === 'true';
const hexSample = (buf?: Buffer | Uint8Array, n: number = 8): string => {
  if (!buf) return '';
  try {
    return Buffer.from(buf).toString('hex').slice(0, n * 2);
  } catch {
    return '';
  }
};

export interface DecryptMessageParams {
  jid: string;
  type: 'pkmsg' | 'msg' | 'skmsg' | 'plaintext';
  ciphertext: Buffer;
  remoteIdentityKey?: Buffer;
}

export class SignalRepository {
  private storage: SignalProtocolStore;
  private instanceId?: string;

  private constructor(storage: SignalProtocolStore, instanceId?: string) {
    this.storage = storage;
    this.instanceId = instanceId;
  }

  updateCompanionKey(companionKey: Buffer): void {
    this.storage.updateCompanionKey(companionKey);
  }

  getStorage(): SignalProtocolStore {
    return this.storage;
  }

  async decryptMessage({ jid, type, ciphertext, remoteIdentityKey }: DecryptMessageParams): Promise<Buffer> {
    Logger.debug(`🔓 [SIGNAL_REPO] Descriptografando ${type} de ${jid}...`);
    if (VERBOSE_SIGNAL_LOG) {
      Logger.debug(`🔎 [SIGNAL_REPO] dispatch params: ctLen=${ciphertext?.length ?? 0}, ctHexSample=${hexSample(ciphertext)}, remoteIdLen=${remoteIdentityKey?.length ?? 0}, remoteIdHexSample=${hexSample(remoteIdentityKey)}`);
    }

    try {
      let decryptedBuffer: Buffer;

      switch (type) {
        case 'pkmsg':
          decryptedBuffer = await this.decryptPreKeyMessage(jid, ciphertext, 0, remoteIdentityKey);
          break;

        case 'msg':
          decryptedBuffer = await this.decryptSignalMessage(jid, ciphertext);
          break;

        case 'skmsg':
          throw new Error('SenderKeyMessage não implementado ainda');

        case 'plaintext':
          decryptedBuffer = ciphertext;
          break;

        default:
          throw new Error(`Tipo de mensagem não suportado: ${type}`);
      }

      return decryptedBuffer;
    } catch (error) {
      Logger.error('❌ [SIGNAL_REPO] Erro na descriptografia:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        jid,
        type,
        ciphertextLength: ciphertext.length
      });
      throw error;
    }
  }

  public async decryptPreKeyMessage(
    jid: string,
    ciphertext: Buffer,
    deviceId: number = 0,
    remoteIdentityKey?: Buffer
  ): Promise<Buffer> {
    try {
      const extractedDevice = parseDeviceFromJid(jid) || deviceId || 0;
      const addrInfo = createSignalProtocolAddress(jid, extractedDevice);

      Logger.debug(`🔓 [SIGNAL_REPO] Descriptografando pkmsg de ${addrInfo.name}:${addrInfo.deviceId}`);
      const address = new libsignal.ProtocolAddress(addrInfo.name, addrInfo.deviceId);
      const cipher = new libsignal.SessionCipher(this.storage, address);

      // Persistir identidade se fornecida
      if (remoteIdentityKey && remoteIdentityKey.length > 0) {
        try {
          // Garantir que a chave tenha o prefixo 0x05 se necessário
          const formattedKey = remoteIdentityKey.length === 33 
            ? remoteIdentityKey 
            : Buffer.concat([Buffer.from([0x05]), remoteIdentityKey]);
            
          await this.storage.storeIdentity(addrInfo, formattedKey);
          
          Logger.debug(`🔑 [SIGNAL_REPO] IdentityKey persistida: len=${formattedKey.length}, hexSample=${formattedKey.toString('hex').slice(0,16)}`);

          // Forçar persistência imediata da identidade no banco
          if (this.storage.authState && typeof this.storage.authState.saveKeysToDatabase === 'function') {
            await this.storage.authState.saveKeysToDatabase();
            Logger.info(`💾 [SIGNAL_REPO] IdentityKey do peer persistida no banco para ${addrInfo.name}:${addrInfo.deviceId}`);
          }
          
          Logger.info(`🔑 [SIGNAL_REPO] IdentityKey do peer armazenada para ${addrInfo.name}:${addrInfo.deviceId}`);
        } catch (e) {
          Logger.warn(`⚠️ [SIGNAL_REPO] Falha ao armazenar IdentityKey: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Para mensagens de pré-chave, SEMPRE usar decryptPreKeyWhisperMessage
      // O método já inicializa o ratchet e realiza a descriptografia em um passo
      const decrypted = await cipher.decryptPreKeyWhisperMessage(ciphertext);

      // Persistir sessão
      const record = await this.storage.loadSession(addrInfo);
      if (record) await this.storage.storeSession(addrInfo, record);

      // Reforçar persistência após descriptografia completa
      const recordAfterDecrypt = await this.storage.loadSession(addrInfo);
      if (recordAfterDecrypt) {
        await this.storage.storeSession(addrInfo, recordAfterDecrypt);
        Logger.debug(`💾 [SIGNAL_REPO] Sessão atualizada após decryptPreKeyWhisperMessage para ${addrInfo.name}:${addrInfo.deviceId}`);
      }

      // Retorne os bytes brutos; o unpad será realizado em NoiseHandler
      return Buffer.from(decrypted);
    } catch (error) {
      Logger.error(`❌ [SIGNAL_REPO] Erro na descriptografia pkmsg: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  public async decryptSignalMessage(jid: string, ciphertext: Buffer, deviceId: number = 0): Promise<Buffer> {
    try {
      const extractedDevice = parseDeviceFromJid(jid) || deviceId || 0;
      const addrInfo = createSignalProtocolAddress(jid, extractedDevice);

      Logger.debug(`🔓 [SIGNAL_REPO] Descriptografando msg de ${addrInfo.name}:${addrInfo.deviceId}`);
      const address = new libsignal.ProtocolAddress(addrInfo.name, addrInfo.deviceId);
      const cipher = new libsignal.SessionCipher(this.storage, address);

      const decrypted = await cipher.decryptWhisperMessage(ciphertext);

      const record = await this.storage.loadSession(addrInfo);
      if (record) await this.storage.storeSession(addrInfo, record);

      // Retorne os bytes brutos; o unpad será realizado em NoiseHandler
      return Buffer.from(decrypted);
    } catch (error) {
      Logger.error(`❌ [SIGNAL_REPO] Erro na descriptografia msg: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  static async create(authCreds: AuthenticationCreds, keyStore: SignalKeyStore, instanceId?: string, authState?: any): Promise<SignalRepository> {
    const identityKeyPair = {
      pubKey: ensureBuffer(generateSignalPubKey(authCreds.signedIdentityKey.public)),
      privKey: ensureBuffer(authCreds.signedIdentityKey.private)
    };
    
    Logger.info(`🔄 [SIGNAL_REPO] Criando SignalRepository para ${instanceId || 'unknown'}`);

    // Garante registrationId válido (> 0)
    let registrationId = authCreds.registrationId || 0;
    if (!registrationId || registrationId <= 0) {
      try {
        const { generateRegistrationId } = await import('../utils/generics');
        registrationId = generateRegistrationId();
        Logger.warn(`⚠️ [SIGNAL_REPO] registrationId ausente/zero nas credenciais. Gerado novo: ${registrationId}`);
      } catch (e) {
        Logger.warn(`⚠️ [SIGNAL_REPO] Falha ao gerar registrationId dinâmico, usando fallback 1: ${e instanceof Error ? e.message : String(e)}`);
        registrationId = 1;
      }
    }

    const storage = new SignalProtocolStore(
      keyStore,
      identityKeyPair,
      registrationId,
      authCreds,
      instanceId,
      authState
    );

    return new SignalRepository(storage, instanceId);
  }

  async createSession(jid: string, preKeyBundle: any): Promise<void> {
    try {
      Logger.info(`🔄 [SIGNAL_REPO] Criando sessão com ${jid}`);
      const extractedDevice = parseDeviceFromJid(jid) || 0;
      const effectiveDeviceId = preKeyBundle.deviceId || extractedDevice;

      const addrInfo = createSignalProtocolAddress(jid, effectiveDeviceId);
      const address = new libsignal.ProtocolAddress(addrInfo.name, addrInfo.deviceId);

      const sessionBuilder = new libsignal.SessionBuilder(this.storage, address);

      const bundle: any = {
        registrationId: preKeyBundle.registrationId,
        identityKey: preKeyBundle.identityKey,
        signedPreKey: {
          keyId: preKeyBundle.signedPreKeyId,
          publicKey: preKeyBundle.signedPreKeyPublic,
          signature: preKeyBundle.signedPreKeySignature
        }
      };

      if (preKeyBundle.preKeyId !== undefined && preKeyBundle.preKeyPublic) {
        bundle.preKey = { keyId: preKeyBundle.preKeyId, publicKey: preKeyBundle.preKeyPublic };
      }

      await sessionBuilder.processPreKey(bundle);
      Logger.info(`✅ [SIGNAL_REPO] Sessão criada com sucesso para ${addrInfo.name}:${addrInfo.deviceId}`);

      const record = await this.storage.loadSession(addrInfo);
      if (record) await this.storage.storeSession(addrInfo, record);
    } catch (error) {
      Logger.error(`❌ [SIGNAL_REPO] Erro ao criar sessão: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
}
