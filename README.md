# Азбука — Your Cyrillic Companion

<p align="center">
  <img src="icons/icon-192.png" alt="Азбука logo" width="128" height="128"/>
</p>

<p align="center">
  <em>Aprenda o alfabeto cirílico e frases russas que importam — privado, offline, pessoal.</em>
</p>

**Azbuka** (_Азбука_, "alfabeto" em russo) é um Progressive Web App pessoal para aprender o alfabeto cirílico e um punhado de expressões russas úteis — as que de fato aparecem na sua vida. Foi construído com um usuário específico em mente: um falante de português namorando uma russa, começando do zero.

## Features

- **33 letras** do alfabeto cirílico, com nome, som, exemplo e dica de pronúncia em português.
- **45 frases iniciais** já em cirílico + transliteração + nota de contexto — organizadas em:
  - Romance (15) — declarações, apelidos, despedidas
  - Família (15) — formalidades, "muito prazer", jantar com os sogros
  - Sobrevivência (15) — "quanto custa?", "onde fica o banheiro?", socorro
- **Repetição espaçada** (algoritmo SM-2) — volta com a carta minutos antes de você esquecer.
- **Text-to-Speech** nativo do iOS/Android em russo — toque para ouvir qualquer palavra.
- **Grave a voz dela** — em cada carta há um botão de microfone. A gravação fica salva no aparelho e toca no lugar do TTS.
- **Adicione suas próprias cartas** — o app é para crescer com vocês dois.
- **Backup e import** — exporte tudo (cartas + progresso + áudios) como um JSON; restaure em outro aparelho.
- **100% offline, 100% local.** Sem contas, sem servidor, sem analytics.
- **Instalável no iPhone** via Safari → Compartilhar → Adicionar à tela de início.

## Arquitetura

- HTML + CSS + JavaScript vanilla. Sem build step, sem framework, sem npm.
- Armazenamento: **IndexedDB** para cartas, progresso, áudios; chaves simples em objeto `settings`.
- Áudio in: `MediaRecorder` (WebM/Opus, fallback mp4).
- Áudio out: `SpeechSynthesisUtterance` com `lang='ru-RU'`. Baixe a voz russa em _Ajustes → Acessibilidade → Conteúdo Falado → Vozes_ para a melhor qualidade offline.
- Service worker com cache do shell (stale-while-revalidate) para offline.
- Hospedado via **GitHub Pages**.

## Desenvolver localmente

Service workers e `fetch()` não funcionam em `file://`. Use qualquer servidor estático:

```bash
# Opção 1 — Python
python3 -m http.server 8080

# Opção 2 — Node
npx --yes http-server -p 8080 -c-1
```

Depois abra <http://localhost:8080>.

No iPhone, use o IP da sua máquina (por exemplo, `http://192.168.0.42:8080`) e o mesmo Wi-Fi.

## Estrutura

```
index.html              shell da aplicação
app.js                  toda a lógica (storage, SRS, views, TTS, rec)
styles.css              tema claro/escuro/auto
manifest.webmanifest    metadados PWA
sw.js                   service worker offline
starter-cards.json      as 78 cartas iniciais (editáveis)
icons/                  logo SVG + PNGs em vários tamanhos
favicon.ico             ícone do navegador
scripts/gen_icons.py    gera os PNGs a partir do Python/PIL
IDEAS.md                ideias de features para o futuro
```

## Automação diária no iPhone

Depois de _Adicionar à Tela de Início_:

1. Abra o app **Atalhos** → **Automação** → **+**.
2. _Criar Automação Pessoal_ → **Hora do Dia** → escolha o horário.
3. Ação: **Abrir URL** → cole a URL do GitHub Pages do app.
4. Ative **Executar Imediatamente** (sem pedir confirmação).
5. Toque no atalho no centro de notificações e cai direto na sessão do dia.

## Roadmap

Veja [`IDEAS.md`](IDEAS.md) — features do Phase 3 e além, mantidas fora do codebase até a hora delas.

## Privacidade

Os dados vivem só aqui. Nada sobe para nenhum servidor, nenhum analytics, nenhum tracking. Safari pode evacuar dados de sites pouco usados depois de semanas — por isso existe o **Exportar backup** nos ajustes. Use-o de vez em quando.

## Licença

MIT — veja [`LICENSE`](LICENSE).
