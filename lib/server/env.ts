/**
 * Lectura y validación de variables de entorno (solo servidor)
 * Normaliza el formato de la private key y valida que existan.
 */

export interface EnvCredentials {
  apiKey: string;
  privateKey: string; // siempre con prefijo 0x, 66 chars
  subAccountId: string;
  useTestnet: boolean;
}

export interface EnvStatus {
  ok: boolean;
  missing: string[];
  masked: {
    apiKey: string;
    signerAddress: string; // dirección derivada (no la private key)
    subAccountId: string;
  } | null;
}

/**
 * Normaliza una private key: acepta con o sin 0x, valida longitud.
 * Lanza error si el formato es inválido.
 */
function normalizePrivateKey(raw: string): string {
  const cleaned = raw.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) {
    throw new Error(
      `GRVT_PRIVATE_KEY_EIP712 inválida: debe ser un hex de 64 caracteres (con o sin prefijo 0x). ` +
        `Longitud recibida: ${cleaned.length} chars.`
    );
  }
  return `0x${cleaned}`;
}

/**
 * Enmascara un string mostrando los primeros N y últimos M caracteres.
 * Ejemplo: "0x1234...abcd"
 */
export function maskSecret(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail) return "***";
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

/**
 * Lee y valida las credenciales desde process.env.
 * Solo llamar desde código server-side (API Routes, Server Components).
 */
export function readEnvCredentials(): EnvCredentials {
  const apiKey = process.env.GRVT_API_KEY ?? "";
  const privateKeyRaw = process.env.GRVT_PRIVATE_KEY_EIP712 ?? "";
  const subAccountId = process.env.GRVT_SUB_ACCOUNT_ID ?? "";
  const useTestnet = process.env.GRVT_USE_TESTNET === "true";

  const missing: string[] = [];
  if (!apiKey) missing.push("GRVT_API_KEY");
  if (!privateKeyRaw || privateKeyRaw === "0x") missing.push("GRVT_PRIVATE_KEY_EIP712");
  if (!subAccountId) missing.push("GRVT_SUB_ACCOUNT_ID");

  if (missing.length > 0) {
    throw new Error(`Faltan variables de entorno: ${missing.join(", ")}`);
  }

  const privateKey = normalizePrivateKey(privateKeyRaw);

  return { apiKey, privateKey, subAccountId, useTestnet };
}

/**
 * Retorna el estado de las credenciales sin exponer valores sensibles.
 * Seguro para enviar al cliente.
 */
export async function getEnvStatus(): Promise<EnvStatus> {
  const apiKey = process.env.GRVT_API_KEY ?? "";
  const privateKeyRaw = process.env.GRVT_PRIVATE_KEY_EIP712 ?? "";
  const subAccountId = process.env.GRVT_SUB_ACCOUNT_ID ?? "";

  const missing: string[] = [];
  if (!apiKey) missing.push("GRVT_API_KEY");
  if (!privateKeyRaw || privateKeyRaw === "0x") missing.push("GRVT_PRIVATE_KEY_EIP712");
  if (!subAccountId) missing.push("GRVT_SUB_ACCOUNT_ID");

  if (missing.length > 0) {
    return { ok: false, missing, masked: null };
  }

  // Derivar la dirección pública de la private key para mostrársela al usuario
  let signerAddress = "0x???";
  try {
    const privateKey = normalizePrivateKey(privateKeyRaw);
    // Importación dinámica de ethers solo en el servidor
    const { ethers } = await import("ethers");
    const wallet = new ethers.Wallet(privateKey);
    signerAddress = wallet.address;
  } catch {
    return {
      ok: false,
      missing: ["GRVT_PRIVATE_KEY_EIP712 (formato inválido)"],
      masked: null,
    };
  }

  return {
    ok: true,
    missing: [],
    masked: {
      apiKey: maskSecret(apiKey, 8, 4),
      signerAddress: maskSecret(signerAddress, 6, 4), // 0x1234...abcd
      subAccountId: maskSecret(subAccountId, 3, 3),
    },
  };
}
