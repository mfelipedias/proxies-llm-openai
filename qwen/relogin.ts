/*
 * Script descartável: reabre um perfil existente (acc1/acc2/acc3/_default) num
 * navegador VISÍVEL para você logar de novo e resolver o captcha/slider na mão.
 * A sessão renovada persiste no perfil; depois é só rodar o proxy normal.
 *
 * Uso:  npx tsx relogin.ts acc1
 *       npx tsx relogin.ts acc2 --browser=chrome
 */
import { launchManualLoginAccount, extractAccountInfoFromContext, BrowserType } from './src/services/playwright.ts'

const accountId = process.argv.find(a => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1])
const browserArg = process.argv.find(a => a.startsWith('--browser='))
const browserType = (browserArg ? browserArg.split('=')[1] : 'chrome') as BrowserType

if (!accountId) {
  console.error('Informe o perfil. Ex.: npx tsx relogin.ts acc1')
  process.exit(1)
}

console.log(`\nAbrindo perfil "${accountId}" em ${browserType} (janela visível)...`)
console.log('1) Faça login se aparecer a tela de login.')
console.log('2) Mande UMA mensagem qualquer no chat para forçar o captcha.')
console.log('3) Resolva o slider/captcha se ele aparecer.')
console.log('Quando a sessão estiver ativa, este script detecta e fecha sozinho.\n')

const { context, page } = await launchManualLoginAccount(accountId, browserType)

let ok = false
for (let i = 0; i < 600 && !ok; i++) { // ~20 min
  await new Promise(r => setTimeout(r, 2000))
  try {
    const { hasSession } = await extractAccountInfoFromContext(page)
    if (hasSession && !page.url().includes('/auth')) ok = true
  } catch { /* página navegando, tenta de novo */ }
}

console.log(ok ? `\n✅ Sessão de "${accountId}" salva no perfil.` : `\n⚠️  Tempo esgotado — verifique se logou.`)
await context.close()
process.exit(0)
