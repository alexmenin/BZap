declare module 'libsignal' {
  export function curve25519_sign(privateKey: Buffer, message: Buffer): Buffer;
  export function curve25519_verify(publicKey: Buffer, message: Buffer, signature: Buffer): boolean;
  export function curve25519_generate_public(privateKey: Buffer): Buffer;
  export function curve25519_generate_private(): Buffer;
  export function curve25519_calculate_agreement(publicKey: Buffer, privateKey: Buffer): Buffer;
  export function curve25519_calculate_signature(random: Buffer, privateKey: Buffer, message: Buffer): Buffer;
  export function curve25519_verify_signature(publicKey: Buffer, message: Buffer, signature: Buffer): boolean;

  export interface KeyPair {
    pubKey: Uint8Array;
    privKey: Uint8Array;
  }

  export namespace curve {
    function generateKeyPair(): KeyPair;
    function calculateAgreement(publicKey: Buffer | Uint8Array, privateKey: Buffer | Uint8Array): Uint8Array;
    function sign(privateKey: Buffer | Uint8Array, message: Buffer | Uint8Array): Uint8Array;
    function verify(publicKey: Buffer | Uint8Array, message: Buffer | Uint8Array, signature: Buffer | Uint8Array): boolean;
  }
}