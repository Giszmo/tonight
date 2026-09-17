// PPQ.ai client. Pay-per-use inference with no account and no server of ours:
// every endpoint below answers CORS `*`, so the static page talks to it directly.
// The visitor who triggers a scouting run pays for it; the results go to nostr
// where everyone else reads them for free.

export const PPQ_BASE = 'https://api.ppq.ai'
export const DEFAULT_MODEL = 'gemini-3.7-flash'
export const SEARCH_SUFFIX = ':online'   // Exa web search, ~$0.02 per request

const LS = { account: 'tonight.ppq' }

export class InsufficientBalance extends Error {
  constructor() { super('PPQ balance empty'); this.name = 'InsufficientBalance' }
}

export function storedAccount() {
  try { return JSON.parse(localStorage.getItem(LS.account) || 'null') } catch { return null }
}

export function storeAccount(acc) {
  localStorage.setItem(LS.account, JSON.stringify(acc))
  return acc
}

export function forgetAccount() { localStorage.removeItem(LS.account) }

async function call(path, { method = 'POST', body, apiKey, creditId } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = 'Bearer ' + apiKey
  if (creditId) headers['x-credit-id'] = creditId
  const res = await fetch(PPQ_BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 402) throw new InsufficientBalance()
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { /* non-JSON error body */ }
  if (!res.ok) throw new Error(`PPQ ${path} -> ${res.status} ${data?.message || text.slice(0, 200)}`)
  return data
}

// Anonymous account: no email, no login. The credit id is the only handle, and
// it is also the login at ppq.ai, so we show it to the visitor prominently.
export async function createAccount() {
  const data = await call('/accounts/create', { body: {} })
  return storeAccount({ creditId: data.credit_id, apiKey: data.api_key, createdAt: Date.now() })
}

export async function ensureAccount() {
  return storedAccount() || await createAccount()
}

// An existing PPQ user can paste their credit id; we mint a capped sub-key so
// the page can never spend more than the cap.
//
// Two shapes to watch. /accounts/create answers flat ({credit_id, api_key}),
// /keys answers wrapped ({status, data:{api_key}}) - reading the top level here
// yields undefined and the page then fails every later call as unauthorized.
// And key names are unique per credit id, so a fixed name makes the second
// adoption a 409.
export async function adoptCreditId(creditId, { capUsd = 1 } = {}) {
  const name = 'tonight-events-page-' + Math.random().toString(36).slice(2, 8)
  const res = await call('/keys', { creditId, body: { name, usage_limit_usd: capUsd } })
  const data = res?.data || res
  const apiKey = data?.api_key || data?.key || data?.apiKey
  if (!apiKey) throw new Error('PPQ /keys returned no api_key')
  return storeAccount({ creditId, apiKey, capUsd, adopted: true, createdAt: Date.now() })
}

export async function getBalance(acc = storedAccount()) {
  if (!acc) return 0
  const data = await call('/credits/balance', { apiKey: acc.apiKey })
  return Number(data.balance || 0)
}

export async function createLightningTopup(acc, usd) {
  return call('/topup/create/btc-lightning', { apiKey: acc.apiKey, body: { amount: usd, currency: 'USD' } })
}

export async function topupStatus(acc, invoiceId) {
  return call('/topup/status/' + encodeURIComponent(invoiceId), { method: 'GET', apiKey: acc.apiKey })
}

export async function chat(acc, { model = DEFAULT_MODEL, search = true, messages, temperature = 0.2, maxTokens = 4000 }) {
  const data = await call('/v1/chat/completions', {
    apiKey: acc.apiKey,
    body: {
      model: search ? model + SEARCH_SUFFIX : model,
      messages,
      temperature,
      max_tokens: maxTokens,
    },
  })
  return {
    text: data?.choices?.[0]?.message?.content || '',
    usage: data?.usage || null,
    model: data?.model || model,
  }
}

export const sessionUrl = (creditId) => `https://ppq.ai/sessions/${encodeURIComponent(creditId)}`
export const topUpUrl = 'https://ppq.ai/top-up'
