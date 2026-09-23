/*
 * Script descartável: "reseta o pool" — remove TODAS as contas do banco e
 * recadastra as contas do .env com ids fixos e previsíveis (acc1, acc2, ...),
 * para que cada perfil de navegador fique em qwen_profiles/<id>/.
 *
 * Múltiplas contas via .env (numeradas; a 1ª sem sufixo):
 *     QWEN_EMAIL=conta1@exemplo.com   QWEN_PASSWORD=...     -> acc1
 *     QWEN_EMAIL2=conta2@exemplo.com  QWEN_PASSWORD2=...    -> acc2
 *     QWEN_EMAIL3=conta3@exemplo.com  QWEN_PASSWORD3=...    -> acc3
 *
 * Manter >=2 contas dá ao anti-bot (captcha) pra onde rotacionar — com 1 conta
 * só, um captcha derruba todo o proxy até o cooldown expirar.
 *
 * Depois deste script, resolva o captcha de CADA conta uma vez (navegador
 * visível) — a sessão persiste no perfil:
 *     npx tsx relogin.ts acc1 --browser=chrome
 *     npx tsx relogin.ts acc2 --browser=chrome
 *
 * Uso:  npx tsx reset-account.ts
 */
import * as dotenv from 'dotenv'
import { loadAccounts, removeAccount, addAccount, getEnvAccounts } from './src/core/accounts.ts'

dotenv.config()

const desired = getEnvAccounts()
if (desired.length === 0) {
  console.error('Defina ao menos QWEN_EMAIL e QWEN_PASSWORD no .env antes de rodar.')
  process.exit(1)
}

// 1) Remove todas as contas existentes (acc1/acc2/acc3/uuids...)
const existing = loadAccounts()
for (const acc of existing) {
  removeAccount(acc.id)
  console.log(`- removida conta ${acc.email} (id: ${acc.id})`)
}

// 2) Recadastra as contas do .env com ids fixos
for (const a of desired) {
  const created = addAccount(a.email, a.password, a.id)
  console.log(`+ cadastrada ${created.email} (id: ${created.id})`)
}

console.log(`\n✅ Banco agora tem ${desired.length} conta(s): ${desired.map(a => a.id).join(', ')}`)
console.log(`\nPróximo passo — resolva o captcha de cada conta uma vez (navegador visível):`)
for (const a of desired) console.log(`    npx tsx relogin.ts ${a.id} --browser=chrome`)
process.exit(0)
