import crypto from 'crypto'
import { getDatabase } from './database.ts'

export interface QwenAccount {
  id: string
  email: string
  password: string
}

export function loadAccounts(): QwenAccount[] {
  const db = getDatabase()
  const rows = db.prepare('SELECT id, email, password FROM accounts ORDER BY created_at ASC').all()
  return rows as QwenAccount[]
}

export function addAccount(email: string, password: string, id?: string): QwenAccount {
  if (!email || typeof email !== 'string' || email.trim().length === 0) {
    throw new Error('Email is required')
  }

  const db = getDatabase()

  const existing = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email.trim())
  if (existing) {
    throw new Error(`Account with email ${email} already exists`)
  }

  const newAccount: QwenAccount = {
    id: id || crypto.randomUUID(),
    email: email.trim(),
    password,
  }

  db.prepare('INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)').run(
    newAccount.id,
    newAccount.email,
    newAccount.password,
  )

  return newAccount
}

export function removeAccount(id: string): boolean {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  return result.changes > 0
}

export function listAccounts(): QwenAccount[] {
  return loadAccounts().map(a => ({ id: a.id, email: a.email, password: '***' }))
}

export function getAccountCredentials(id: string): QwenAccount | undefined {
  const db = getDatabase()
  const row = db.prepare('SELECT id, email, password FROM accounts WHERE id = ?').get(id)
  return row as QwenAccount | undefined
}

/**
 * Lê as contas configuradas no .env e devolve com ids fixos e previsíveis
 * (acc1, acc2, ...), que casam com os perfis em qwen_profiles/<id>/.
 *
 *   QWEN_EMAIL  / QWEN_PASSWORD   -> acc1   (1ª conta, sem sufixo)
 *   QWEN_EMAIL2 / QWEN_PASSWORD2  -> acc2
 *   QWEN_EMAIL3 / QWEN_PASSWORD3  -> acc3   ... e assim por diante
 *
 * Para no primeiro par numerado ausente. Usado pelo auto-cadastro do servidor
 * e pelo reset-account.ts, mantendo uma única fonte da verdade.
 */
export function getEnvAccounts(): QwenAccount[] {
  const out: QwenAccount[] = []
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : String(n)
    const email = process.env[`QWEN_EMAIL${suffix}`]
    const password = process.env[`QWEN_PASSWORD${suffix}`]
    if (!email || !password) break
    out.push({ id: `acc${n}`, email: email.trim(), password })
  }
  return out
}
