// MessageDecryption.ts - Descriptografia de mensagens criptografadas do WhatsApp
// Refatorado para usar libsignal nativo com implementação consistente

import { waproto } from '@wppconnect/wa-proto';
import { Logger } from '../utils/Logger';
import { BinaryNode } from '../protocol/WABinary/decode';
import { aesDecryptGCM, Curve } from './Curve25519';
import { AuthenticationCreds, SignalKeyStore } from '../auth/AuthStateManager';
import { ensureBuffer } from '../utils/BufferUtils';
import { KeyManager } from './KeyManager';
import { 
  SignalProtocolStore, 
  PreKeyBundle 
} from './SignalProtocolStore';
import { createSignalProtocolAddress, parseDeviceFromJid, normalizeJid as normalizeJidUtil } from '../utils/SignalUtils';

const libsignal = require('libsignal');

/**
 * Interface para resultado da descriptografia
 */
export interface DecryptionResult {
  success: boolean;
  decryptedMessage?: waproto.IWebMessageInfo;
  error?: string;
}

/**
 * Tipos de criptografia suportados
 */
export enum EncryptionType {
  PKMSG = 'pkmsg',  // Pre-key message (primeira mensagem)
  MSG = 'msg'       // Mensagem normal
}

/**
 * Classe para descriptografia de mensagens do WhatsApp usando libsignal nativo
 */
export class MessageDecryption {
  // Evita singleton global que mistura identidades; usa um mapa por identidade
  private static stores = new Map<string, SignalProtocolStore>();
  private static authState: any;

  private static storeKeyFromCreds(authCreds: AuthenticationCreds): string {
    const pub = ensureBuffer(authCreds.signedIdentityKey.public);
    return `id:${pub.toString('base64')}`;
  }
  
  /**
   * Inicializa o SignalProtocolStore
   */
  private static async initializeSignalStore(
    authCreds: AuthenticationCreds,
    keyStore: SignalKeyStore,
    forceRecreate = false,
    instanceId?: string,
    authState?: any
  ): Promise<SignalProtocolStore> {
    const key = this.storeKeyFromCreds(authCreds);
    if (!forceRecreate && this.stores.has(key)) {
      return this.stores.get(key)!;
    }
    // Normaliza base64→bytes para o par de chaves de identidade
    const identityKeyPair = {
      pubKey: ensureBuffer(authCreds.signedIdentityKey.public),
      privKey: ensureBuffer(authCreds.signedIdentityKey.private)
    };
    // Garante registrationId válido (> 0)
    let registrationId = authCreds.registrationId || 0;
    if (!registrationId || registrationId <= 0) {
      try {
        const { generateRegistrationId } = await import('../utils/generics');
        registrationId = generateRegistrationId();
        Logger.warn(`⚠️ RegistrationId ausente/zero nas credenciais. Gerado novo: ${registrationId}`);
      } catch (e) {
        Logger.warn(`⚠️ Falha ao gerar registrationId dinâmico, usando fallback 1: ${e instanceof Error ? e.message : String(e)}`);
        registrationId = 1;
      }
    }

    const store = new SignalProtocolStore(
      keyStore,
      identityKeyPair,
      registrationId,
      authCreds,
      instanceId,
      authState
    );
    this.stores.set(key, store);
    this.authState = authState; // Armazenar authState para uso futuro
    Logger.info(`🔐 SignalProtocolStore inicializado para identity ${key.slice(3, 11)}…`);
    return store;
  }
  
  /**
   * Descriptografa nó de mensagem criptografada usando libsignal nativo
   * @param encNode - Nó binário com dados criptografados
   * @param authCreds - Credenciais de autenticação
   * @param keyStore - Store de chaves para salvar sessões
   * @param senderJid - JID do remetente
   * @param authStateManager - Gerenciador de estado para pre-keys
   * @returns Resultado da descriptografia
   */
  public static async decryptMessageNode(
    encNode: BinaryNode,
    authCreds: AuthenticationCreds,
    keyStore?: SignalKeyStore,
    senderJid?: string,
    authStateManager?: any,
    remoteIdentityKey?: Uint8Array
  ): Promise<DecryptionResult> {
    const encType = encNode.attrs?.type as EncryptionType;
    const version = encNode.attrs?.v;
    
    // Extrai JID do remetente para salvar sessão
    const extractedSenderJid = senderJid || encNode.attrs?.from || encNode.attrs?.participant;
    
    try {
      Logger.crypto('DECRYPT', `Iniciando descriptografia libsignal - tipo: ${encType}, versão: ${version}, remetente: ${extractedSenderJid}`);
      
      if (!encNode.content || !(encNode.content instanceof Uint8Array)) {
        return {
          success: false,
          error: 'Conteúdo da mensagem criptografada inválido'
        };
      }
      
      if (!keyStore || !extractedSenderJid) {
        return {
          success: false,
          error: 'KeyStore e senderJid são obrigatórios para descriptografia libsignal'
        };
      }
      
      const encryptedData = Buffer.from(encNode.content);
      
      // Inicializa SignalProtocolStore
      const signalStore = await this.initializeSignalStore(
        authCreds,
        keyStore,
        false,
        (authStateManager as any)?.instanceId,
        authStateManager
      );
      
      // Descriptografa baseado no tipo usando libsignal
      let decryptedBuffer: Buffer;
      
      switch (encType) {
        case EncryptionType.PKMSG:
          decryptedBuffer = await this.decryptPreKeyMessageWithLibsignal(
            encryptedData, 
            extractedSenderJid,
            signalStore,
            authStateManager,
            remoteIdentityKey
          );
          break;
          
        case EncryptionType.MSG:
          decryptedBuffer = await this.decryptMessageWithLibsignal(
            encryptedData,
            extractedSenderJid,
            signalStore
          );
          break;
          
        default:
          return {
            success: false,
            error: `Tipo de criptografia não suportado: ${encType}`
          };
      }
      
      // Decodifica a mensagem descriptografada usando waproto
      const webMessageInfo = waproto.WebMessageInfo.decode(decryptedBuffer);
      
      Logger.crypto('DECRYPT', 'Mensagem descriptografada com libsignal com sucesso', {
        messageId: webMessageInfo.key?.id,
        fromMe: webMessageInfo.key?.fromMe,
        participant: webMessageInfo.key?.participant
      });
      
      return {
        success: true,
        decryptedMessage: webMessageInfo
      };
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      
      Logger.error('❌ Erro ao descriptografar mensagem com libsignal', {
        error: errorMessage,
        stack: errorStack,
        senderJid: extractedSenderJid || 'unknown',
        encType: encType || 'unknown',
        errorType: error instanceof Error ? error.constructor.name : typeof error
      });
      
      // ✅ CORREÇÃO: Remover fallback legado que causa "Invalid key length"
      // Sempre usar libsignal para pkmsg, não tentar AES-GCM manual
      return {
        success: false,
        error: `Falha na descriptografia libsignal: ${errorMessage}`
      };
    }
  }
  
  /**
   * Remove padding PKCS7 dos dados descriptografados
   */
  private static unpadRandomMax16(e: Uint8Array | Buffer): Uint8Array {
    const t = new Uint8Array(e);
    if (0 === t.length) {
      throw new Error('unpadPkcs7 given empty bytes');
    }
    
    const r = t[t.length - 1];
    if (r > t.length) {
      throw new Error(`unpad given ${t.length} bytes, but pad is ${r}`);
    }
    
    return new Uint8Array(t.buffer, t.byteOffset, t.length - r);
  }
  
  /**
   * Normaliza JID removendo informações de device
   */
  private static normalizeJid(jid: string): string {
    return normalizeJidUtil(jid);
  }

  /**
   * Importa chaves de um PreKeyBundle para estabelecer uma sessão
   */
  private static async processPreKeyBundle(bundle: any, remoteJid: string, signalStore: SignalProtocolStore, deviceId: number = 0): Promise<void> {
    try {
      // Normaliza o JID para remover qualquer informação de device
      const normalizedJid = this.normalizeJid(remoteJid);
      const addrInfo = createSignalProtocolAddress(normalizedJid, deviceId);
      const address = new libsignal.ProtocolAddress(addrInfo.name, addrInfo.deviceId);
      const sessionBuilder = new libsignal.SessionBuilder(
        signalStore,
        address
      );
      
      await sessionBuilder.processPreKey(bundle);
      Logger.info(`✅ [SIGNAL] Sessão estabelecida com ${normalizedJid} (device: ${deviceId})`);
    } catch (error) {
      Logger.error(`❌ [SIGNAL] Erro ao processar PreKeyBundle: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Descriptografa mensagem pkmsg usando libsignal SessionCipher
   */
  private static async decryptPreKeyMessageWithLibsignal(
    encryptedData: Buffer,
    senderJid: string,
    signalStore: SignalProtocolStore,
    authStateManager?: any,
    remoteIdentityKey?: Uint8Array
  ): Promise<Buffer> {
    try {
      Logger.info(`🔓 [LIBSIGNAL] Descriptografando pkmsg de: ${senderJid}`);
      
      // Cria endereço do protocolo Signal usando a função helper com extração de device
      const device = parseDeviceFromJid(senderJid) || 0;
      const addressInfo = createSignalProtocolAddress(senderJid, device);
      const address = new libsignal.ProtocolAddress(addressInfo.name, addressInfo.deviceId);
      
      // Verifica se já existe sessão
      const hasSession = await signalStore.containsSession(addressInfo);
      Logger.debug(`🔍 [LIBSIGNAL] Sessão existe para ${senderJid}: ${hasSession}`);
      
      // O WhatsApp usa um formato específico - precisa extrair os dados corretos
      // Os dados vêm como hex string no XML, precisamos processar corretamente
      let processedData: Buffer;
      
      if (typeof encryptedData === 'string') {
        // Se vier como string hex, converte para buffer
        processedData = Buffer.from(encryptedData, 'hex');
      } else if (encryptedData instanceof Uint8Array) {
        // Se vier como Uint8Array, converte para buffer
        processedData = Buffer.from(encryptedData);
      } else {
        // Já é um buffer
        processedData = encryptedData;
      }
      
      Logger.debug(`📊 [LIBSIGNAL] Dados processados: ${processedData.length} bytes`);
      Logger.debug(`📊 [LIBSIGNAL] Primeiros bytes: ${processedData.subarray(0, 20).toString('hex')}`);
      
      // Cria SessionCipher para descriptografia usando o ProtocolAddress nativo
      const sessionCipher = new libsignal.SessionCipher(signalStore, address);
      
      // Quando NÃO há sessão ainda, inicializa o ratchet antes de tentar descriptografar
      if (!hasSession) {
        Logger.warn(`🆕 [LIBSIGNAL] Nenhuma sessão para ${senderJid}. Inicializando ratchet com processPreKeyWhisperMessage...`);
        // Persistir explicitamente a identityKey do peer, se disponível (vem do PreKeyBundle)
        if (remoteIdentityKey && remoteIdentityKey.length > 0) {
          try {
            await signalStore.storeIdentity(addressInfo, Buffer.from(remoteIdentityKey));
            Logger.info(`🔑 [LIBSIGNAL] IdentityKey do peer armazenada explicitamente (${remoteIdentityKey.length} bytes)`);
          } catch (e) {
            Logger.warn(`⚠️ [LIBSIGNAL] Falha ao armazenar explicitamente a IdentityKey do peer: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        const canProcess = typeof (sessionCipher as any).processPreKeyWhisperMessage === 'function';
        if (canProcess) {
          // Inicializa o estado de sessão a partir do pkmsg
          await (sessionCipher as any).processPreKeyWhisperMessage(processedData);
          Logger.info(`✅ [LIBSIGNAL] Ratchet inicializado via processPreKeyWhisperMessage para ${senderJid}`);
          // Persiste a sessão criada
          const record = await signalStore.loadSession(addressInfo);
          if (record) {
            await signalStore.storeSession(addressInfo, record);
            Logger.info(`💾 [LIBSIGNAL] Sessão criada e salva para ${senderJid}`);
          } else {
            Logger.warn(`⚠️ [LIBSIGNAL] processPreKeyWhisperMessage não retornou sessão carregável para ${senderJid}`);
          }
          // Verificar persistência da identidade do remetente
          const maybeIdentity = await signalStore.loadIdentity(addressInfo);
          if (maybeIdentity) {
            Logger.info(`🔑 [LIBSIGNAL] IdentityKey do remetente persistida (${maybeIdentity.length} bytes)`);
          } else {
            Logger.warn(`⚠️ [LIBSIGNAL] IdentityKey do remetente não encontrada após criar sessão`);
          }
        } else {
          Logger.warn(`⚠️ [LIBSIGNAL] processPreKeyWhisperMessage não disponível no SessionCipher. Continuando com decryptPreKeyWhisperMessage...`);
        }
      }

      // Descriptografia conforme estado da sessão
      let decryptedData: Uint8Array;
      if (hasSession) {
        // Mensagens duplicadas: se já há sessão, tente tratar como whisper (MSG)
        Logger.debug(`🔓 [LIBSIGNAL] Sessão já existe — tentando decryptWhisperMessage primeiro...`);
        try {
          decryptedData = await sessionCipher.decryptWhisperMessage(processedData);
          Logger.debug(`✅ [LIBSIGNAL] decryptWhisperMessage bem-sucedido com sessão existente`);
        } catch (errWhisper) {
          const msg = errWhisper instanceof Error ? errWhisper.message : String(errWhisper);
          Logger.warn(`⚠️ [LIBSIGNAL] decryptWhisperMessage falhou com sessão existente, fallback para decryptPreKeyWhisperMessage: ${msg}`);
          decryptedData = await sessionCipher.decryptPreKeyWhisperMessage(processedData);
          // Garantir persistência imediata do ratchet após fallback
          const recordAfterFallback = await signalStore.loadSession(addressInfo);
          if (recordAfterFallback) {
            await signalStore.storeSession(addressInfo, recordAfterFallback);
            Logger.debug(`💾 [LIBSIGNAL] Sessão persistida imediatamente após fallback pkmsg→whisper para ${senderJid}`);
          }
        }
      } else {
        // Primeira mensagem — usar pkmsg
        Logger.debug(`🔓 [LIBSIGNAL] Descriptografando PreKeyWhisperMessage...`);
        decryptedData = await sessionCipher.decryptPreKeyWhisperMessage(processedData);
      }

      // Remove padding PKCS7
      const unpaddedData = this.unpadRandomMax16(decryptedData);

      Logger.crypto('DECRYPT', `✅ [LIBSIGNAL] PKMSG descriptografada com sucesso`, {
        originalSize: processedData.length,
        decryptedSize: decryptedData.length,
        unpaddedSize: unpaddedData.length,
        senderJid
      });

      // Garantir que a sessão esteja persistida após a primeira descriptografia
      const maybeRecord = await signalStore.loadSession(addressInfo);
      if (maybeRecord) {
        await signalStore.storeSession(addressInfo, maybeRecord);
        Logger.debug(`💾 [LIBSIGNAL] Sessão verificada e persistida para ${senderJid}`);
      } else {
        Logger.warn(`⚠️ [LIBSIGNAL] Após descriptografia não foi possível carregar sessão para ${senderJid}`);
      }
      
      return Buffer.from(unpaddedData);
      
    } catch (libsignalError) {
      const errorMessage = libsignalError instanceof Error ? libsignalError.message : String(libsignalError);
      const errorStack = libsignalError instanceof Error ? libsignalError.stack : undefined;
      
      Logger.error(`❌ [LIBSIGNAL] Falha na descriptografia pkmsg de ${senderJid}:`, {
        error: errorMessage,
        stack: errorStack,
        senderJid,
        errorType: libsignalError instanceof Error ? libsignalError.constructor.name : typeof libsignalError
      });
      // Dica adicional de correção quando Bad MAC ocorrer sem sessão
      if (typeof errorMessage === 'string' && /mac/i.test(errorMessage)) {
        Logger.warn(`🚑 [LIBSIGNAL] Bad MAC detectado. Verifique se a sessão foi criada antes da descriptografia (processPreKeyWhisperMessage + storeSession).`);
      }
      throw libsignalError;
    }
  }
  
  /**
   * Descriptografa mensagem normal usando libsignal SessionCipher
   */
  private static async decryptMessageWithLibsignal(
    encryptedData: Buffer,
    senderJid: string,
    signalStore: SignalProtocolStore
  ): Promise<Buffer> {
    try {
      Logger.info(`🔓 [LIBSIGNAL] Descriptografando msg de: ${senderJid}`);
      
      // Cria endereço do protocolo Signal usando a classe nativa do libsignal
      const addressInfo = createSignalProtocolAddress(senderJid);
      const address = new libsignal.ProtocolAddress(addressInfo.name, addressInfo.deviceId);
      
      // Verifica se existe sessão
      const hasSession = await signalStore.containsSession(addressInfo);
      if (!hasSession) {
        throw new Error(`Nenhuma sessão encontrada para ${senderJid} - mensagem MSG requer sessão existente`);
      }
      
      // Cria SessionCipher e descriptografa usando o ProtocolAddress nativo
      const sessionCipher = new libsignal.SessionCipher(signalStore, address);
      const decryptedArray = await sessionCipher.decryptWhisperMessage(encryptedData);
      
      // Remove padding PKCS7
      const unpaddedData = this.unpadRandomMax16(decryptedArray);
      const decryptedBuffer = Buffer.from(unpaddedData);
      
      // 💾 Garantir persistência da sessão após descriptografia MSG
      try {
        const record = await signalStore.loadSession(addressInfo);
        if (record) {
          await signalStore.storeSession(addressInfo, record);
          Logger.debug(`💾 [LIBSIGNAL] Sessão persistida para ${senderJid} após MSG`);
        }
      } catch (e) {
        Logger.warn(`⚠️ [LIBSIGNAL] Falha ao persistir sessão pós-MSG: ${e instanceof Error ? e.message : String(e)}`);
      }

      Logger.info(`✅ [LIBSIGNAL] Mensagem MSG descriptografada com sucesso (${decryptedBuffer.length} bytes)`);
      return decryptedBuffer;
      
    } catch (error) {
      Logger.error(`❌ [LIBSIGNAL] Falha na descriptografia msg de ${senderJid}:`, error);
      throw error;
    }
  }

  
  
  
  /**
   * Verifica se um nó é uma mensagem criptografada
   * @param node - Nó a ser verificado
   * @returns true se for uma mensagem criptografada
   */
  public static isEncryptedMessage(node: BinaryNode): boolean {
    return node.tag === 'enc' && 
           typeof node.attrs?.type === 'string' &&
           (node.attrs.type === 'pkmsg' || node.attrs.type === 'msg');
  }
  
  /**
   * Extrai o nó <enc> de uma mensagem
   * @param messageNode - Nó da mensagem
   * @returns Nó <enc> se encontrado
   */
  public static extractEncNode(messageNode: BinaryNode): BinaryNode | null {
    if (messageNode.tag === 'enc') {
      return messageNode;
    }
    
    if (Array.isArray(messageNode.content)) {
      for (const child of messageNode.content) {
        if (typeof child === 'object' && child.tag === 'enc') {
          return child;
        }
      }
    }
    
    return null;
  }
}