/**
 * Implementação Curve25519 para WhatsApp Web
 * Baseado na implementação do Baileys-master usando libsignal
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto';
import * as curve from 'libsignal/src/curve';
import { AUTH_CONFIG } from '../constants/Constants';

// insure browser & node compatibility
const { subtle } = globalThis.crypto;

declare type BufferSource = ArrayBufferView | ArrayBuffer;

export interface KeyPair {
  private: Buffer;
  public: Buffer;
}

/** prefix version byte to the pub keys, required for some curve crypto functions */
export const generateSignalPubKey = (pubKey: Uint8Array | Buffer) =>
  pubKey.length === 33 ? pubKey : Buffer.concat([AUTH_CONFIG.KEY_BUNDLE_TYPE, pubKey]);

export const Curve = {
	generateKeyPair: (): KeyPair => {
		const { pubKey, privKey } = curve.generateKeyPair();
		return {
			private: Buffer.from(privKey),
			// remove version byte
			public: Buffer.from(pubKey.slice(1))
		};
	},
	sharedKey: (privateKey: Uint8Array, publicKey: Uint8Array) => {
		// Converte Uint8Array para Buffer para compatibilidade com libsignal
		const privateKeyBuffer = Buffer.from(privateKey);
		const shared = curve.calculateAgreement(generateSignalPubKey(publicKey), privateKeyBuffer);
		return Buffer.from(shared);
	},
	sign: (privateKey: Uint8Array, buf: Uint8Array) => curve.calculateSignature(privateKey, buf),
	verify: (pubKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => {
		try {
			curve.verifySignature(generateSignalPubKey(pubKey), message, signature);
			return true;
		} catch (error) {
			return false;
		}
	}
};

export const signedKeyPair = (identityKeyPair: KeyPair, keyId: number) => {
	const preKey = Curve.generateKeyPair();
	const pubKey = generateSignalPubKey(preKey.public);

	const signature = Curve.sign(identityKeyPair.private, pubKey);

	return { keyPair: preKey, signature, keyId };
};

const GCM_TAG_LENGTH = 128 >> 3;

/**
 * encrypt AES 256 GCM;
 * where the tag tag is suffixed to the ciphertext
 * */
export function aesEncryptGCM(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array, additionalData: Uint8Array) {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(additionalData);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/**
 * decrypt AES 256 GCM;
 * where the auth tag is suffixed to the ciphertext
 * */
export function aesDecryptGCM(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array, additionalData: Uint8Array) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    
    // decrypt additional adata
    const enc = ciphertext.slice(0, ciphertext.length - GCM_TAG_LENGTH);
    const tag = ciphertext.slice(ciphertext.length - GCM_TAG_LENGTH);
    
    // set additional data
    decipher.setAAD(additionalData);
    decipher.setAuthTag(tag);

    const updateResult = decipher.update(enc);
    const finalResult = decipher.final();
    const decrypted = Buffer.concat([updateResult, finalResult]);
    
    return decrypted;
  } catch (error) {
     console.error('❌ [AES-GCM ERROR] Falha na descriptografia:', (error as Error).message);
     throw error;
   }
}

export function aesEncryptCTR(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array) {
  const cipher = createCipheriv('aes-256-ctr', key, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function aesDecryptCTR(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array) {
  const decipher = createDecipheriv('aes-256-ctr', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** decrypt AES 256 CBC; where the IV is prefixed to the buffer */
export function aesDecrypt(buffer: Buffer, key: Buffer) {
  return aesDecryptWithIV(buffer.slice(16, buffer.length), key, buffer.slice(0, 16));
}

/** decrypt AES 256 CBC */
export function aesDecryptWithIV(buffer: Buffer, key: Buffer, IV: Buffer) {
  const aes = createDecipheriv('aes-256-cbc', key, IV);
  return Buffer.concat([aes.update(buffer), aes.final()]);
}

// encrypt AES 256 CBC; where a random IV is prefixed to the buffer
export function aesEncrypt(buffer: Buffer | Uint8Array, key: Buffer) {
  const IV = randomBytes(16);
  const aes = createCipheriv('aes-256-cbc', key, IV);
  return Buffer.concat([IV, aes.update(buffer), aes.final()]); // prefix IV to the buffer
}

// encrypt AES 256 CBC with a given IV
export function aesEncryptWithIV(buffer: Buffer, key: Buffer, IV: Buffer) {
  const aes = createCipheriv('aes-256-cbc', key, IV);
  return Buffer.concat([aes.update(buffer), aes.final()]); // prefix IV to the buffer
}

// sign HMAC using SHA 256
export function hmacSign(
  buffer: Buffer | Uint8Array,
  key: Buffer | Uint8Array,
  variant: 'sha256' | 'sha512' = 'sha256'
) {
  return createHmac(variant, key).update(buffer).digest();
}

export function sha256(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest();
}

export function md5(buffer: Buffer) {
  return createHash('md5').update(buffer).digest();
}

// HKDF key expansion
export async function hkdf(
	buffer: Uint8Array | Buffer,
	expandedLength: number,
	info: { salt?: Buffer; info?: string }
): Promise<Buffer> {
	// Implementação idêntica ao Baileys-master usando Web Crypto API
	const inputKeyMaterial = new Uint8Array(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
	const salt = info.salt ? new Uint8Array(info.salt) : new Uint8Array(0);
	const infoBytes = info.info ? new TextEncoder().encode(info.info) : new Uint8Array(0);

	const importedKey = await globalThis.crypto.subtle.importKey('raw', inputKeyMaterial as BufferSource, { name: 'HKDF' }, false, [
		'deriveBits'
	]);

	const derivedBits = await globalThis.crypto.subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: salt,
			info: infoBytes
		},
		importedKey,
		expandedLength * 8
	);

	return Buffer.from(derivedBits);
}

export async function derivePairingCodeKey(pairingCode: string, salt: Buffer): Promise<Buffer> {
	// Convert inputs to formats Web Crypto API can work with
	const encoder = new TextEncoder();
	const pairingCodeBuffer = encoder.encode(pairingCode);
	const saltBuffer = new Uint8Array(salt instanceof Uint8Array ? salt : new Uint8Array(salt));

	// Import the pairing code as key material
	const keyMaterial = await globalThis.crypto.subtle.importKey('raw', pairingCodeBuffer as BufferSource, { name: 'PBKDF2' }, false, [
		'deriveBits'
	]);

	// Derive bits using PBKDF2 with the same parameters
	// 2 << 16 = 131,072 iterations
	const derivedBits = await globalThis.crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			salt: saltBuffer as BufferSource,
			iterations: 2 << 16,
			hash: 'SHA-256'
		},
		keyMaterial,
		32 * 8 // 32 bytes * 8 = 256 bits
	);

	return Buffer.from(derivedBits);
}

// Classe principal para compatibilidade
export class Curve25519 {
  public static generateKeyPair(): { private: Uint8Array; public: Uint8Array } {
    const keyPair = Curve.generateKeyPair();
    return {
      private: new Uint8Array(keyPair.private),
      public: new Uint8Array(keyPair.public)
    };
  }

  public static sign(privateKey: Buffer, data: Buffer): Buffer {
    return Buffer.from(Curve.sign(privateKey, data));
  }

  public static generatePublicKey(privateKey: Uint8Array): Uint8Array {
    // Para compatibilidade, usar a implementação do Curve
    const keyPair = Curve.generateKeyPair();
    return keyPair.public;
  }

  public static sharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
    return Curve.sharedKey(privateKey, publicKey);
  }
}

export const cryptoUtils = {
  // Geração de chaves
  generateKeyPair: () => Curve.generateKeyPair(),
  
  // Obter chave pública
  getPublicKey: (privateKey: Uint8Array) => {
    const keyPair = Curve.generateKeyPair();
    return keyPair.public;
  },
  
  // ECDH
  ecdh: (privateKey: Uint8Array, publicKey: Uint8Array) => Curve.sharedKey(privateKey, publicKey),
  
  // Assinatura
  sign: (privateKey: Uint8Array, message: Uint8Array) => Curve.sign(privateKey, message),
  
  // Verificação
  verify: (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => 
    Curve.verify(publicKey, message, signature),
  
  // Utilitários
  randomBytes: (length: number) => randomBytes(length),
  
  // Conversões
  toHex: (data: Uint8Array) => Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(''),
  
  fromHex: (hex: string) => new Uint8Array(hex.match(/.{2}/g)?.map(byte => parseInt(byte, 16)) || []),
  
  // Base64
  toBase64: (data: Uint8Array) => Buffer.from(data).toString('base64'),
  
  fromBase64: (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'))
};

// Exportação padrão
export default {
  Curve,
  generateSignalPubKey,
  signedKeyPair,
  aesEncryptGCM,
  aesDecryptGCM,
  aesEncryptCTR,
  aesDecryptCTR,
  aesEncrypt,
  aesDecrypt,
  aesEncryptWithIV,
  aesDecryptWithIV,
  hmacSign,
  sha256,
  md5,
  hkdf,
  derivePairingCodeKey,
  cryptoUtils
};