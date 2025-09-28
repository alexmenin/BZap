// KeyManager.ts - Gerenciamento de chaves criptográficas para o protocolo WhatsApp

import { randomBytes, createHash, createHmac } from 'crypto';
import * as sodium from 'libsodium-wrappers';
import { CRYPTO_CONFIG, AUTH_CONFIG } from '../constants/Constants';

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