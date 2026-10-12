# Painel

Painel pessoal, uma página só, sem servidor. O código é aberto para qualquer pessoa conferir o que ele faz.
**Nenhum dado pessoal fica neste repositório.**

## Como os dados ficam protegidos

- Tudo que o usuário lança é cifrado no próprio aparelho com uma senha (PBKDF2-SHA256, 600 mil iterações, AES-256-GCM).
  A senha não é guardada; sem ela o conteúdo salvo é ilegível.
- A página só pode falar com dois destinos, e isso é imposto pelo `Content-Security-Policy` do `index.html`:
  a fonte pública de preços (CoinGecko) e os servidores públicos da Trezor (somente leitura).
- Nada de script, fonte ou imagem de terceiros.
- Backup é um arquivo já cifrado com a mesma senha.
- `.gitignore` bloqueia planilhas, CSV, PDF e arquivos de backup.

## Rodar e testar

```bash
node tools/servir.mjs        # abre em http://localhost:5280
node --test tests/logica.test.mjs
node tools/gerar-icones.mjs  # regenera os ícones
```

## Publicar uma versão nova

Altere `version.json` (ex.: `2026.10.12-2`). Quem estiver com o app instalado recebe a versão na próxima abertura com internet.
