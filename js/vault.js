// Cofre: tudo que é seu fica cifrado com a sua senha (PBKDF2 + AES-GCM) antes de tocar no disco.
// A senha nunca é guardada; sem ela o conteúdo salvo é ilegível.

const enc = new TextEncoder();
const dec = new TextDecoder();
const AAD = enc.encode('painel:v1');

export const ITER = 600_000;
const CHAVE_LS = 'painel.cofre.v1';

function paraB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
const deB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function derivar(senha, salt, iteracoes) {
  const base = await crypto.subtle.importKey('raw', enc.encode(senha.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iteracoes },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Cifra o estado com a chave da sessão. Um IV novo a cada gravação.
export async function selar(sessao, estado) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: AAD },
    sessao.chave,
    enc.encode(JSON.stringify(estado)),
  );
  return { v: 1, it: sessao.it, salt: paraB64(sessao.salt), iv: paraB64(iv), ct: paraB64(new Uint8Array(ct)) };
}

export async function criar(senha, estado) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const sessao = { chave: await derivar(senha, salt, ITER), salt, it: ITER };
  return { sessao, envelope: await selar(sessao, estado) };
}

export function envelopeValido(e) {
  return !!e && e.v === 1 && Number.isInteger(e.it) && e.it >= 100_000 && e.it <= 5_000_000 &&
    ['salt', 'iv', 'ct'].every((k) => typeof e[k] === 'string' && e[k].length > 0);
}

export async function abrir(senha, envelope) {
  if (!envelopeValido(envelope)) throw new Error('arquivo-invalido');
  const salt = deB64(envelope.salt);
  const chave = await derivar(senha, salt, envelope.it);
  try {
    const claro = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: deB64(envelope.iv), additionalData: AAD },
      chave,
      deB64(envelope.ct),
    );
    return { sessao: { chave, salt, it: envelope.it }, estado: JSON.parse(dec.decode(claro)) };
  } catch {
    throw new Error('senha-errada');
  }
}

// Troca a senha: novo salt, nova chave, estado re-cifrado.
export async function trocarSenha(novaSenha, estado) {
  return criar(novaSenha, estado);
}

// --- Armazenamento local (só envelopes cifrados + a lista de nomes dos cofres) ---
// O primeiro cofre ("principal") continua na chave antiga, então quem já tinha um cofre não precisa migrar nada.
// Os nomes dos cofres ficam em texto claro (aparecem na tela de entrada): use nomes neutros.
const CHAVE_LISTA = 'painel.cofres.v1';
const chaveEnv = (id) => (id === 'principal' ? CHAVE_LS : CHAVE_LS + '.' + id);

export function listar() {
  let lista = [];
  try {
    const l = JSON.parse(localStorage.getItem(CHAVE_LISTA));
    if (Array.isArray(l)) lista = l.filter((c) => c && typeof c.id === 'string' && typeof c.nome === 'string');
  } catch { /* lista ausente ou corrompida */ }
  try {
    if (!lista.some((c) => c.id === 'principal') && localStorage.getItem(CHAVE_LS)) lista.unshift({ id: 'principal', nome: 'Principal' });
  } catch { /* sem armazenamento */ }
  return lista;
}
function gravarLista(lista) { localStorage.setItem(CHAVE_LISTA, JSON.stringify(lista)); }

export const existe = () => listar().length > 0;
export const novoId = () => (listar().length === 0 ? 'principal' : crypto.randomUUID().slice(0, 8));

export function registrar(id, nome) {
  gravarLista([...listar().filter((c) => c.id !== id), { id, nome }]);
}
export function renomear(id, nome) {
  gravarLista(listar().map((c) => (c.id === id ? { ...c, nome } : c)));
}
export function ler(id) {
  try { return JSON.parse(localStorage.getItem(chaveEnv(id))); } catch { return null; }
}
export function guardar(id, envelope) {
  localStorage.setItem(chaveEnv(id), JSON.stringify(envelope));
}
export function apagar(id) {
  const restantes = listar().filter((c) => c.id !== id);
  try { localStorage.removeItem(chaveEnv(id)); } catch { /* nada a apagar */ }
  gravarLista(restantes);
}
