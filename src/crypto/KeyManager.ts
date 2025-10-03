// KeyManager.ts - Gerenciamento de chaves criptográficas para o protocolo WhatsApp

import { randomBytes, createHash, createHmac } from 'crypto';
import * as sodium from 'libsodium-wrappers';
import { AUTH_CONFIG } from '../constants/Constants';

// Usar API de curva diretamente do libsignal
import * as curve from 'libsignal/src/curve';

/**
 * Interface para par de chaves ECDH
 */
export interface KeyPair {
  public: Buffer;
  private: Buffer;
}

/**
 * Interface para pre-key
 */
export interface PreKey {
  keyId: number;
  keyPair: KeyPair;
}

/**
 * Interface para signed pre-key
 */
export interface SignedPreKey {
  keyId: number;
  keyPair: KeyPair;
  signature: Buffer;
}

/**
 * Interface para dados de identidade do dispositivo
 */
export interface DeviceIdentity {
  identityKey: Buffer;
  identityPrivateKey: Buffer;
  advSecretKey: Buffer;
  registrationId: number;
  signedPreKeyId: number;
}/**
 * Gerenciador de chaves criptográficas
 */
export class KeyManager {
  private static readonly CURVE25519_KEY_SIZE = 32;
  private static readonly ADV_SECRET_KEY_SIZE = 32;
  private static deviceIdentity: DeviceIdentity | null = null;

  /**
   * Gera chave pública Signal com prefixo DJB se necessário
   */
  private static generateSignalPubKey(pubKey: Buffer): Buffer {
    // Constante movida para Constants.ts
    return pubKey.length === 33 ? pubKey : Buffer.concat([AUTH_CONFIG.KEY_BUNDLE_TYPE, pubKey]);
  }

  /** * Inicializa libsodium */
  private static async initSodium(): Promise<void> {
    await sodium.ready;
  }

  /**
   * Gera um par de chaves Curve25519 para ECDH usando libsignal (igual ao Baileys)
   */
  public static generateKeyPair(): KeyPair {
    const { pubKey, privKey } = curve.generateKeyPair();
    
    const keyPair: KeyPair = {
       private: Buffer.from(privKey),
       public: Buffer.from(pubKey.slice(1)) // Remove o primeiro byte (tipo)
     };

    console.log('🔑 Par de chaves Curve25519 gerado (libsignal):');
    console.log(`   Privada: ${keyPair.private.toString('hex')}`);
    console.log(`   Pública: ${keyPair.public.toString('hex')}`);

    return keyPair;
  }

  /**
   * Deriva a chave pública da chave privada usando Curve25519
   */
  public static derivePublicKey(privateKey: Buffer): Buffer {
    if (privateKey.length !== this.CURVE25519_KEY_SIZE) {
      throw new Error('Chave privada deve ter 32 bytes para Curve25519');
    }

    // TODO: Implementar derivação correta com libsodium/libsignal
    const keyPair = { public: randomBytes(32) };
    return Buffer.from(keyPair.public); // Sem prefixo DJB aqui
  }

  /**
   * Computa shared secret usando Curve25519 com libsignal
   */
  public static computeSharedSecret(
    privateKey: Buffer,
    publicKey: Buffer
  ): Buffer {
    if (
      privateKey.length !== this.CURVE25519_KEY_SIZE ||
      publicKey.length !== this.CURVE25519_KEY_SIZE
    ) {
      throw new Error('Tamanho de chave inválido para Curve25519');
    }

    // Adiciona prefixo DJB se necessário para libsignal
    const djbPublicKey = publicKey.length === 32 
      ? Buffer.concat([Buffer.from([0x05]), publicKey])
      : publicKey;
    
    try {
      const shared = curve.calculateAgreement(djbPublicKey, privateKey);
      
      console.log(
        `🤝 Shared secret computado (libsignal Curve25519): ${Buffer.from(shared).toString('hex')}`
      );

      return Buffer.from(shared);
    } catch (error) {
      throw new Error(`Falha ao computar segredo compartilhado: ${error}`);
    }
  }

  public static hkdf(prk: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
    const hmac = createHmac('sha256', salt);
    hmac.update(prk);
    const prkDigest = hmac.digest();

    let t = Buffer.alloc(0);
    let okm = Buffer.alloc(0);
    let i = 1;

    while (okm.length < length) {
      const hmacInner = createHmac('sha256', prkDigest);
      hmacInner.update(Buffer.concat([t, info, Buffer.from([i])]))
      t = Buffer.from(hmacInner.digest());
      okm = Buffer.concat([okm, t]);
      i++;
    }

    return okm.slice(0, length);
  }


  /**
   * Criptografia AES-256-GCM (igual ao Baileys)
   */
  public static aesEncryptGCM(
    plaintext: Buffer,
    key: Buffer,
    iv: Buffer,
    additionalData: Buffer
  ): Buffer {
    const { createCipheriv } = require('crypto');
    const cipher = createCipheriv('aes-256-gcm', key, iv);

    cipher.setAAD(additionalData);

    const encrypted = Buffer.concat([
      cipher.update(plaintext),
      cipher.final()
    ]);

    const tag = cipher.getAuthTag();
    return Buffer.concat([encrypted, tag]);
  }

  /**
   * Descriptografia AES-256-GCM (igual ao Baileys)
   */
  public static aesDecryptGCM(
    ciphertext: Buffer,
    key: Buffer,
    iv: Buffer,
    additionalData: Buffer
  ): Buffer {
    const { createDecipheriv } = require('crypto');
    const GCM_TAG_LENGTH = 16; // 128 bits / 8

    const encrypted = ciphertext.slice(0, -GCM_TAG_LENGTH);
    const tag = ciphertext.slice(-GCM_TAG_LENGTH);

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(additionalData);
    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
  }

  /**
   * Gera HMAC-SHA256
   */
  public static hmacSign(
    buffer: Buffer,
    key: Buffer,
    variant: 'sha256' | 'sha512' = 'sha256'
  ): Buffer {
    return createHmac(variant, key).update(buffer).digest();
  }

  /**
   * Gera um hash SHA256
   */
  public static sha256(data: Buffer): Buffer {
    return createHash('sha256').update(data).digest();
  }

  /**
   * Gera bytes aleatórios seguros
   */
  public static randomBytes(size: number): Buffer {
    return randomBytes(size);
  }

  /**
   * Valida se um buffer tem o tamanho esperado para Curve25519
   */
  public static isValidCurve25519Key(key: Buffer): boolean {
    return key.length === this.CURVE25519_KEY_SIZE;
  }

  /**
   * Converte chave para formato hexadecimal
   */
  public static keyToHex(key: Buffer): string {
    return key.toString('hex');
  }

  /**
   * Converte chave de formato hexadecimal para Buffer
   */
  public static keyFromHex(hex: string): Buffer {
    if (hex.length !== this.CURVE25519_KEY_SIZE * 2) {
      throw new Error('Formato hexadecimal inválido para chave Curve25519');
    }
    return Buffer.from(hex, 'hex');
  }

  /**
   * Gera ou recupera a identidade do dispositivo
   */
  public static async getDeviceIdentity(): Promise<DeviceIdentity> {
    if (!this.deviceIdentity) {
      this.deviceIdentity = await this.generateDeviceIdentity();
    }
    return this.deviceIdentity;
  }

  /**
   * Gera uma nova identidade do dispositivo usando libsignal (como na Baileys)
   */
  private static async generateDeviceIdentity(): Promise<DeviceIdentity> {
    await this.initSodium();

    // Gera par de chaves de identidade usando libsignal
    const { pubKey, privKey } = curve.generateKeyPair();
    const identityPrivateKey = Buffer.from(privKey);
    const identityPublicKey = Buffer.from(pubKey.slice(1)); // Remove o primeiro byte (tipo)
    
    // Gera chave secreta ADV (32 bytes aleatórios)
    const advSecretKey = randomBytes(this.ADV_SECRET_KEY_SIZE);
    
    // Gera ID de registro (1-16383)
    const registrationId = Math.floor(Math.random() * 16383) + 1;
    const signedPreKeyId = Math.floor(Math.random() * 0xFFFFFF) + 1;

    console.log('🆔 Identidade do dispositivo gerada com libsignal:');
    console.log(`   Registration ID: ${registrationId}`);
    console.log(`   Signed PreKey ID: ${signedPreKeyId}`);
    console.log(`   ADV Secret Key: ${advSecretKey.toString('hex')}`);
    console.log(`   Identity Key Public: ${identityPublicKey.toString('hex')}`);
    return {
      identityKey: identityPublicKey,
      identityPrivateKey: identityPrivateKey,
      advSecretKey,
      registrationId,
      signedPreKeyId
    };
  }

  /**
   * Gera HMAC-SHA256 para autenticação ADV
   */
  public static generateADVHMAC(advSecretKey: Buffer, data: Buffer): Buffer {
    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', advSecretKey);
    hmac.update(data);
    return hmac.digest();
  }

  /**
   * Gera assinatura XEdDSA usando libsignal
   */
  public static async generateXEdDSASignature(
    identityPrivateKey: Buffer,
    publicKey: Buffer,
    message?: Buffer
  ): Promise<Buffer> {
    console.log(`✍️ Gerando assinatura XEdDSA para chave pública: ${publicKey.toString('hex')}`);

    // Para XEdDSA, precisamos converter a chave Ed25519 para Curve25519
    // e depois assinar a chave pública junto com a mensagem (se fornecida)
    const dataToSign = message ? Buffer.concat([publicKey, message]) : publicKey;

    // Usar a implementação real do libsignal para assinatura
    const signature = curve.calculateSignature(identityPrivateKey, dataToSign);

    console.log(`✍️ Assinatura XEdDSA gerada: ${Buffer.from(signature).toString('hex')}`);

    return Buffer.from(signature);
  }

  /**
   * Gera múltiplas pre-keys
   */
  public static generatePreKeys(startId: number, count: number): PreKey[] {
    const preKeys: PreKey[] = [];
    
    for (let i = 0; i < count; i++) {
      const keyId = startId + i;
      const keyPair = this.generateKeyPair();
      
      preKeys.push({
        keyId,
        keyPair
      });
    }
    
    console.log(`🔑 Geradas ${count} pre-keys (IDs: ${startId} - ${startId + count - 1})`);
    return preKeys;
  }

  /**
   * Gera uma signed pre-key
   */
  public static generateSignedPreKey(identityKeyPair: KeyPair, keyId: number): SignedPreKey {
    const keyPair = this.generateKeyPair();
    
    // Adiciona prefixo DJB à chave pública para assinatura
    const pubKeyWithPrefix = this.generateSignalPubKey(keyPair.public);
    
    // Assina a chave pública com a chave de identidade
    const signature = curve.calculateSignature(identityKeyPair.private, pubKeyWithPrefix);
    
    console.log(`🔏 Signed pre-key gerada (ID: ${keyId})`);
    
    return {
      keyId,
      keyPair,
      signature: Buffer.from(signature)
    };
  }

  /**
   * Remove uma pre-key consumida do keyStore
   */
  public static async removeConsumedPreKey(keyStore: any, keyId: number): Promise<void> {
    try {
      const key = `pre-key:${keyId}`;
      
      // Remove do cache
      if (keyStore.keysCache && keyStore.keysCache.has(key)) {
        keyStore.keysCache.delete(key);
        console.log(`🗑️ Pre-key ${keyId} removida do cache`);
      }
      
      // Marca como usada no banco de dados
      if (keyStore.instanceId) {
        await keyStore.markPreKeyAsUsed(keyId);
        console.log(`🗑️ Pre-key ${keyId} marcada como usada no banco`);
      }
      
      // Força salvamento das mudanças
      if (keyStore.debouncedSaveKeys) {
        keyStore.debouncedSaveKeys();
      }
      
    } catch (error) {
      console.error(`❌ Erro ao remover pre-key ${keyId}:`, error);
    }
  }

  /**
   * Verifica se é necessário regenerar pre-keys
   */
  public static async checkAndRegeneratePreKeys(keyStore: any, minPreKeys: number = 10): Promise<void> {
    try {
      const availablePreKeys = await this.countAvailablePreKeys(keyStore);
      
      if (availablePreKeys < minPreKeys) {
        console.log(`⚠️ Estoque baixo de pre-keys: ${availablePreKeys}/${minPreKeys}`);
        await this.regeneratePreKeys(keyStore, 100); // Gera 100 novas pre-keys
      }
    } catch (error) {
      console.error('❌ Erro ao verificar/regenerar pre-keys:', error);
    }
  }

  /**
   * Conta pre-keys disponíveis
   */
  private static async countAvailablePreKeys(keyStore: any): Promise<number> {
    if (!keyStore.keysCache) return 0;
    
    let count = 0;
    for (const [key] of keyStore.keysCache.entries()) {
      if (key.startsWith('pre-key:')) {
        count++;
      }
    }
    
    return count;
  }

  /**
   * Regenera pre-keys quando estoque está baixo
   */
  private static async regeneratePreKeys(keyStore: any, count: number): Promise<void> {
    try {
      // Obtém o próximo ID de pre-key
      const nextPreKeyId = await this.getNextPreKeyId(keyStore);
      
      // Gera novas pre-keys
      const newPreKeys = this.generatePreKeys(nextPreKeyId, count);
      
      // Adiciona ao cache
      for (const preKey of newPreKeys) {
        const key = `pre-key:${preKey.keyId}`;
        keyStore.keysCache.set(key, {
          keyId: preKey.keyId,
          public: preKey.keyPair.public,
          private: preKey.keyPair.private
        });
      }

      // ✅ Duplicar a primeira pre-key como fallback id=0 (nunca removida)
      // Removido comportamento de fallback id=0 para alinhar ao Baileys/Signal
      
      // Atualiza o nextPreKeyId
      if (keyStore.updateNextPreKeyId) {
        await keyStore.updateNextPreKeyId(nextPreKeyId + count);
      }
      
      // Salva no banco
      if (keyStore.debouncedSaveKeys) {
        keyStore.debouncedSaveKeys();
      }
      
      console.log(`✅ ${count} novas pre-keys geradas e salvas`);
      
    } catch (error) {
      console.error('❌ Erro ao regenerar pre-keys:', error);
    }
  }

  /**
   * Obtém o próximo ID de pre-key disponível
   */
  private static async getNextPreKeyId(keyStore: any): Promise<number> {
    try {
      // Tenta obter do keyStore primeiro
      const creds = await keyStore.get('creds');
      if (creds && creds.nextPreKeyId) {
        return creds.nextPreKeyId;
      }
      
      // Se não encontrar, calcula baseado nas pre-keys existentes
      const preKeys = await keyStore.get('pre-key') || {};
      const existingIds = Object.keys(preKeys).map(id => parseInt(id)).filter(id => !isNaN(id));
      
      if (existingIds.length === 0) {
        return 1; // Começa do 1 se não há pre-keys
      }
      
      return Math.max(...existingIds) + 1;
    } catch (error) {
      console.error('❌ Erro ao obter próximo pre-key ID:', error);
      return 1; // Fallback
    }
  }

  /**
   * Verifica assinatura XEdDSA
   */
  public static async verifyXEdDSASignature(
    identityPublicKey: Buffer,
    publicKey: Buffer,
    signature: Buffer,
    message?: Buffer
  ): Promise<boolean> {
    try {
      const dataToVerify = message ? Buffer.concat([publicKey, message]) : publicKey;
      
      // Usar a implementação real do libsignal para verificação
      curve.verifySignature(identityPublicKey, dataToVerify, signature);
      return true;
    } catch (error) {
      console.log(`❌ Falha na verificação XEdDSA: ${error}`);
      return false;
    }
  }
}