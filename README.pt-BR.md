<p align="right"><a href="README.md">English</a> | <b>Português (BR)</b></p>

# mefcs-mcp

Um servidor [MCP](https://modelcontextprotocol.io) que permite que assistentes de IA (Claude, Cursor, VS Code Copilot, Gemini CLI, Codex e qualquer outro cliente MCP) controlem uma pedaleira **M-VAVE Tank-G** (a única suportada por enquanto; veja [Compatibilidade](#compatibilidade)) e busquem timbres no **TONE3000**.

Ele conversa com o pedal pelo USB usando o mesmo protocolo do app oficial **M-EFCS**. O protocolo foi descoberto por engenharia reversa e está documentado em [docs/PROTOCOL.md](docs/PROTOCOL.md). O servidor usa o programa auxiliar de USB que vem com o M-EFCS, então não é preciso instalar nada no pedal.

> Projeto não oficial, sem vínculo com a M-VAVE / Sinco ou com o TONE3000. Atualização de firmware, reparo e restauração de fábrica **não** foram implementados, de propósito.

---

## Sumário

1. [Compatibilidade](#compatibilidade)
2. [O que ele faz](#o-que-ele-faz)
3. [Requisitos](#requisitos)
4. [Instalação](#instalação)
5. [Conectando a um cliente de IA](#conectando-a-um-cliente-de-ia)
6. [Configuração](#configuração)
7. [Configurando o TONE3000](#configurando-o-tone3000)
8. [Referência das ferramentas](#referência-das-ferramentas)
9. [Exemplos de pedidos](#exemplos-de-pedidos)
10. [Segurança](#segurança)
11. [Como funciona](#como-funciona)
12. [Solução de problemas](#solução-de-problemas)
13. [Desenvolvimento](#desenvolvimento)
14. [Publicação](#publicação)
15. [Licença](#licença)

---

## Compatibilidade

> **Por enquanto este servidor funciona só com a M-VAVE Tank-G (v2).** As outras pedaleiras da M-VAVE ainda não são suportadas.

Ele foi feito e testado com:

| | Versão testada |
|---|---|
| Pedal | M-VAVE **Tank-G v2** |
| Firmware do pedal | **098** (o pedal se identifica como `TANK-Gv2_098`) |
| App M-EFCS | **3.11.2015** para Windows (`m_efcs.exe`, que traz o `mefcs_ks_bridge.exe`) |
| Sistema | Windows 11 Pro (build 26300) |
| Node.js | 20.20.2 |

Outras versões de firmware ou do M-EFCS podem funcionar, mas não foram testadas. Um M-EFCS mais novo pode mudar o programa auxiliar de USB ou o protocolo do pedal. Se algo quebrar no seu equipamento, [abra uma issue](https://github.com/cayocan/mefcs-mcp/issues) informando as versões do firmware e do M-EFCS.

**Próximos passos:** está nos planos suportar a **Black Box**, a **MK-300** e outras pedaleiras da M-VAVE. Cada pedal precisa do seu próprio driver, feito a partir de capturas do tráfego USB dele, então quem tem esses pedais e quiser ajudar com capturas é bem-vindo (veja [Desenvolvimento](#desenvolvimento)).

---

## O que ele faz

**Pedal (Tank-G)**
- Lê os 36 presets ou os valores ao vivo do preset ativo.
- Troca de preset e liga ou desliga o bypass.
- Edita qualquer valor e salva no pedal: slot de amp, gain, equalização, volume, gate, tipo e knobs de MOD / DELAY / REVERB, slot de cab e cor do LED. Antes de salvar, faz backup automático.
- Ajusta o preset ativo ao vivo, sem salvar.
- Exporta e importa arquivos `.atkg`, no mesmo formato do "Share/Import all presets" do M-EFCS. A importação faz backup e confere o resultado.
- Envia uma captura de amp (`.nam` **A2**, convertida para "A2 Lite (Original)" como o M-EFCS faz) para os slots de amp 1 a 9, ou só toca em prévia.
- Envia uma resposta de impulso de caixa (`.wav` de qualquer taxa e resolução, convertida para 44,1 kHz) para os slots de cab 1 a 8, ou só toca em prévia.

**TONE3000**
- Busca timbres por texto, tipo de equipamento, marca/modelo, tags ou criador. Por padrão traz capturas NAM A2, mas também busca IRs.
- Mostra os detalhes de um tone e os modelos disponíveis para baixar.
- Baixa arquivos `.nam` / `.wav`.
- Instala um modelo do TONE3000 direto num slot do pedal, num passo só.
- Quando falta chave ou login, o servidor **abre a página certa do TONE3000 no seu navegador**.

## Requisitos

| | |
|---|---|
| Sistema | Windows 10/11, porque o auxiliar de USB é um programa de Windows |
| Node.js | 20 ou mais novo (`node -v`) |
| M-EFCS | Instalado, porque o servidor usa o `mefcs_ks_bridge.exe` dele |
| Pedal | M-VAVE Tank-G (v2) ligado por USB |
| TONE3000 | Conta gratuita, só para as ferramentas do TONE3000 |

**Importante:** só um programa fala com o pedal por vez. **Feche o M-EFCS** antes de a IA usar uma ferramenta do pedal. Antes de abrir o M-EFCS de novo, peça para a IA rodar `tankg_disconnect`.

## Instalação

```powershell
# 1. Baixe o código
git clone https://github.com/cayocan/mefcs-mcp.git
cd mefcs-mcp

# 2. Instale as dependências e compile
npm install
npm run build

# 3. Opcional: rode os testes (comparam com tráfego real capturado do M-EFCS)
npm test
```

O ponto de entrada do servidor é `dist/src/server.js`. Quando o pacote estiver publicado no npm, dá para pular o clone e usar `npx -y mefcs-mcp` (veja [Publicação](#publicação)).

Localize o caminho completo do `mefcs_ks_bridge.exe` dentro da pasta do M-EFCS, por exemplo `C:\Program Files\M-EFCS\mefcs_ks_bridge.exe`. Os locais padrão são detectados sozinhos; se o seu for diferente, defina `MEFCS_BRIDGE_PATH`.

## Conectando a um cliente de IA

O MCP é um padrão aberto, então o mesmo servidor funciona em qualquer cliente que aceite servidores MCP locais (stdio). Nos exemplos abaixo, troque os caminhos pelos seus.

### Claude Desktop

Edite `%APPDATA%\Claude\claude_desktop_config.json` e reinicie o Claude Desktop:

```json
{
  "mcpServers": {
    "mefcs": {
      "command": "node",
      "args": ["C:\\caminho\\para\\mefcs-mcp\\dist\\src\\server.js"],
      "env": {
        "MEFCS_BRIDGE_PATH": "C:\\Program Files\\M-EFCS\\mefcs_ks_bridge.exe",
        "MEFCS_BACKUP_DIR": "C:\\caminho\\para\\mefcs-mcp\\backups",
        "TONE3000_DOWNLOAD_DIR": "C:\\caminho\\para\\mefcs-mcp\\downloads"
      }
    }
  }
}
```

### Claude Code

```powershell
claude mcp add mefcs --scope user `
  -e MEFCS_BRIDGE_PATH="C:\Program Files\M-EFCS\mefcs_ks_bridge.exe" `
  -- node "C:\caminho\para\mefcs-mcp\dist\src\server.js"
```

### Cursor

O mesmo bloco `mcpServers` do Claude Desktop vai em `%USERPROFILE%\.cursor\mcp.json` (global) ou em `.cursor/mcp.json` (no projeto).

### VS Code (GitHub Copilot, modo agente)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "mefcs": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\caminho\\para\\mefcs-mcp\\dist\\src\\server.js"],
      "env": { "MEFCS_BRIDGE_PATH": "C:\\Program Files\\M-EFCS\\mefcs_ks_bridge.exe" }
    }
  }
}
```

### Windsurf, Cline, Gemini CLI e outros

Todos aceitam as mesmas três coisas: `command` = `node`, `args` = caminho do `dist/src/server.js` e `env` = as variáveis abaixo. O bloco `mcpServers` do Claude Desktop vai em:
- `~/.codeium/windsurf/mcp_config.json` (Windsurf)
- configurações de MCP do Cline
- `~/.gemini/settings.json` (Gemini CLI)

### OpenAI Codex CLI

`%USERPROFILE%\.codex\config.toml`:

```toml
[mcp_servers.mefcs]
command = "node"
args = ["C:\\caminho\\para\\mefcs-mcp\\dist\\src\\server.js"]
env = { MEFCS_BRIDGE_PATH = "C:\\Program Files\\M-EFCS\\mefcs_ks_bridge.exe" }
```

> Clientes que só aceitam servidores MCP **remotos** (HTTPS), como apps de chat na web, não alcançam um pedal USB direto. O servidor precisa rodar no PC onde o pedal está ligado. Veja [Publicação](#publicação).

## Configuração

| Variável | Padrão | Para que serve |
|---|---|---|
| `MEFCS_BRIDGE_PATH` | detectado em Program Files / LocalAppData | Caminho completo do `mefcs_ks_bridge.exe` |
| `MEFCS_BACKUP_DIR` | `~/mefcs-mcp-backups` | Backups automáticos de presets (`TankG_<data>_<motivo>.atkg`) |
| `TONE3000_DOWNLOAD_DIR` | `~/mefcs-mcp-downloads` | Arquivos `.nam` / `.wav` baixados |
| `TONE3000_CLIENT_ID` | (nenhum) | Chave publicável do TONE3000; também pode ser salva durante o uso |
| `TONE3000_API_KEY` | (nenhum) | Chave secreta `t3k_cs_…` do TONE3000, alternativa ao login |
| `TONE3000_TOKEN_FILE` | `~/.mefcs-mcp/tone3000-tokens.json` | Sessão salva do TONE3000 |
| `MEFCS_CONFIG_FILE` | `~/.mefcs-mcp/config.json` | Chaves salvas com `tone3000_set_credentials` |
| `MEFCS_NO_BROWSER` | (vazio) | `1` para nunca abrir o navegador |

## Configurando o TONE3000

Isso é feito uma vez só e não exige editar nenhum arquivo:

1. Peça para a IA buscar algo no TONE3000, por exemplo "procura um Fender Twin no TONE3000". Sem chave, o servidor **abre https://www.tone3000.com/settings no seu navegador**.
2. Entre na sua conta e gere as chaves de API. Passe a **chave publicável** (client id) para a IA, que salva com `tone3000_set_credentials` em `~/.mefcs-mcp/config.json`, no seu PC.
3. Em seguida o servidor **abre a página de aprovação do TONE3000** já com o seu código. Clique em aprovar e a IA roda `tone3000_login_finish`.
4. Pronto. A sessão fica salva e é renovada sozinha, e daí em diante buscas e downloads funcionam direto.

Prefere não fazer login? Coloque você mesmo a chave secreta (`t3k_cs_…`) em `TONE3000_API_KEY`. Não cole chaves secretas no chat.

Observações:
- O limite padrão é de 100 requisições por minuto.
- A busca traz capturas NAM **A2** por padrão, porque o Tank-G carrega a parte *lite* desses arquivos. Capturas WaveNet padrão (A1) não podem ser convertidas.
- Os termos da API pedem que desenvolvedores independentes deem crédito ao TONE3000.

## Referência das ferramentas

### Pedal

| Ferramenta | Entradas | O que faz |
|---|---|---|
| `tankg_connect` | — | Abre a sessão USB (o M-EFCS precisa estar fechado). As outras ferramentas conectam sozinhas quando precisam. |
| `tankg_disconnect` | — | Libera o pedal para usar o M-EFCS. |
| `tankg_status` | — | Preset ativo (`1A`…`9D`) e estado do bypass. |
| `tankg_list_presets` | — | Os 36 presets salvos, decodificados. |
| `tankg_get_preset` | `preset?`, `live?` | Um preset salvo, ou os valores ao vivo do preset ativo. |
| `tankg_select_preset` | `preset` | Troca de preset. |
| `tankg_update_preset` | `preset`, `changes`, `save?` (padrão true) | Edita e salva. Faz backup antes. Se o preset estiver ativo, também aplica ao vivo. |
| `tankg_set_live_values` | `changes` | Muda o preset ativo sem salvar. |
| `tankg_set_bypass` | `on` | Bypass geral. |
| `tankg_export_presets` | `path` | Salva todos os presets num arquivo `.atkg`. |
| `tankg_import_presets` | `path` | Substitui todos os presets por um `.atkg`, com backup e conferência. |
| `tankg_upload_amp_capture` | `namPath`, `slot?` 1-9, `name?` | Converte uma captura NAM A2 e grava num slot de amp. Sem `slot`, só toca em prévia. |
| `tankg_upload_cab_ir` | `wavPath`, `slot?` 1-8, `level?` 0-100 | Grava um IR WAV num slot de cab (máx. ~30 ms a 44,1 kHz). Sem `slot`, só toca em prévia. |
| `tankg_read_preset_file` | `path` | Decodifica um `.atkg` sem precisar do pedal. |
| `tankg_effect_types` | — | Índices dos tipos de efeito. |

Campos de `changes` (todos opcionais):

| Campo | Faixa |
|---|---|
| `ampOn` | verdadeiro/falso |
| `ampSlot` | 1-9 |
| `gain`, `treble`, `middle`, `bass`, `volume` | 0-100 |
| `gate` | 0-100, 0 = desligado |
| `mod`, `delay`, `reverb` | `{ on, type 0-2, amount, param2 0-100 }` |
| `cabSlot` | 0-8, 0 = desligado |
| `color` | `{ r, g, b }` |

Os tipos de efeito seguem as zonas dos knobs descritas no manual oficial:

| Bloco | tipo 0 | tipo 1 | tipo 2 | amount | param2 |
|---|---|---|---|---|---|
| MOD | chorus | phaser | tremolo | mix | velocidade |
| DELAY | analog | tape | dual | mix | tempo |
| REVERB | room | spring | cloud | decay | mix |

O `amount` vai de 0 a 42 (de 0 a 40 no tipo 2).

### TONE3000

| Ferramenta | Entradas | O que faz |
|---|---|---|
| `tone3000_auth_status` | — | Mostra o modo de autenticação e se você está logado. |
| `tone3000_set_credentials` | `clientId?`, `apiKey?` | Salva as chaves no PC e inicia o login, abrindo a página de aprovação. |
| `tone3000_login_start` / `tone3000_login_finish` | — | Login por código. O start abre o navegador; o finish espera até 60 s pela aprovação. |
| `tone3000_search` | `query?`, `gears?`, `makes?`, `tags?`, `creators?`, `sizes?`, `format?` (`nam`/`ir`), `sort?`, `calibrated?`, `page?`, `pageSize?` | Busca timbres. |
| `tone3000_get_tone` | `toneId` | Detalhes e modelos disponíveis. |
| `tone3000_download_model` | `modelId`, `dir?` | Baixa um `.nam` / `.wav`. |
| `tankg_install_tone3000_model` | `modelId`, `slot?`, `name?`, `cabLevel?` | Baixa e envia para um slot de amp (`.nam`) ou de cab (`.wav`). |

## Exemplos de pedidos

- "Qual preset está ativo no meu Tank-G e o que tem nele?"
- "Desliga o reverb do 5D e baixa o gain para 60."
- "Deixa o chorus do 1A mais sutil sem salvar, quero ouvir antes."
- "Faz backup de todos os meus presets em D:\\Backups\\tankg.atkg."
- "Procura no TONE3000 uma captura de Vox AC30 bem baixada e toca a melhor em prévia."
- "Instala a captura de JCM800 que você achou no slot de amp 4 e aponta o preset 3C para ela."
- "Acha um IR de 4x12 com Celestion V30 no TONE3000 e coloca no slot de cab 5."

## Segurança

- Não existe caminho no código para atualização de firmware, reparo ou restauração de fábrica, e toda escrita passa por uma lista de endereços permitidos (veja `assertAllowedWrite`).
- Edições e importações de presets fazem backup dos 36 presets antes. A importação é conferida lendo o banco de volta.
- Os valores são validados: knobs de 0 a 100 (a faixa do M-EFCS), slots de 1 a 9 / 1 a 8, amount dentro da zona do tipo. Valores antigos que não foram alterados ficam como estão.
- Envio para slot sobrescreve o slot. Sem `slot`, é só prévia e nada é gravado.
- O navegador só é aberto em páginas `https://www.tone3000.com`.
- As chaves e a sessão do TONE3000 ficam no seu PC, em `~/.mefcs-mcp`.

## Como funciona

```
Cliente de IA ──MCP (stdio)──> mefcs-mcp ──stdin/stdout──> mefcs_ks_bridge.exe ──USB MIDI (SysEx)──> Tank-G
                                  └──HTTPS──> API do TONE3000
```

- `src/protocol/bridge.ts`: abre o auxiliar do M-EFCS (`open-raw`) e fala o protocolo de texto dele (`send <hex>` → `data <hex>`).
- `src/protocol/framing.ts`: quadros SysEx. O quadro de 8 bits vira um bitstream de 7 bits (bit menos significativo primeiro), com checksum de soma invertida.
- `src/devices/tankg.ts`: mapa de memória (banco de presets, preset ao vivo, selecionar/bypass/gravar, buffers de modelo, gravação em slot) mais a lista de escritas permitidas.
- `src/devices/tankg-presets.ts`: codec do registro de preset de 21 bytes (formato `.atkg`).
- `src/codecs/a2lite.ts`: NAM A2 → buffer de amp do pedal. Pega o submodelo lite, transpõe os pesos das convoluções e pré-calcula o estado com entrada zero.
- `src/codecs/ir.ts`: WAV → buffer de cab do pedal (44,1 kHz, int24, máx. 1358 amostras).
- `src/tone3000/client.ts`: API v1 do TONE3000 (login por código, busca, modelos, download).

## Solução de problemas

| Problema | Solução |
|---|---|
| "M-EFCS is open" | Feche o M-EFCS; só um programa usa o pedal por vez. |
| "mefcs_ks_bridge.exe not found" | Defina `MEFCS_BRIDGE_PATH` com o arquivo que está dentro da pasta do M-EFCS. |
| "No M-VAVE device found" | Confira o cabo e a porta USB e se o pedal está ligado. |
| "Timed out waiting for the pedal" | Desconecte e reconecte o pedal e tente de novo. Confira se nenhum outro programa está usando o pedal. |
| O M-EFCS não acha o pedal depois de usar a IA | Peça `tankg_disconnect` ou reinicie o cliente de IA. |
| "not an A2 (SlimmableContainer) capture" | Escolha uma captura A2 no TONE3000 (a busca já filtra por elas). |
| Limite de requisições do TONE3000 | Espere um minuto (limite de 100 por minuto). |
| Uma mudança de preset ficou ruim | Restaure o último backup de `MEFCS_BACKUP_DIR` com `tankg_import_presets`. |

## Desenvolvimento

```powershell
npm run build      # TypeScript -> dist/
npm test           # testes contra tráfego real do M-EFCS + testes do cliente TONE3000
node scripts/smoke-test.mjs saida.atkg   # teste ao vivo, só leitura, com o pedal (M-EFCS fechado)
node scripts/normalize-knobs.mjs --dry-run
```

Dois testes comparam com capturas de terceiros do TONE3000 que não são redistribuídas neste repositório. Eles são pulados automaticamente quando `test/fixtures/mesa.nam` / `ir8.wav` não existem.

Para adicionar outro aparelho M-VAVE (Black Box, MK-300, …), crie um driver em `src/devices/` com o mapa de memória e o formato de modelo dele. O enquadramento e a ponte são compartilhados. Antes, capture o tráfego do aparelho (veja `docs/PROTOCOL.md`).

## Publicação

O objetivo é que qualquer pessoa rode com `npx -y mefcs-mcp` e encontre o servidor nos diretórios de MCP.

1. **GitHub:** suba este repositório (por exemplo `github.com/cayocan/mefcs-mcp`) e adicione uma licença.
2. **npm:** rode `npm login` e depois `npm publish`. O `prepublishOnly` compila e testa antes. A partir daí os clientes podem usar:
   ```json
   { "command": "npx", "args": ["-y", "mefcs-mcp"], "env": { "MEFCS_BRIDGE_PATH": "..." } }
   ```
3. **Registro oficial de MCPs:** o `package.json` já tem `"mcpName": "io.github.cayocan/mefcs-mcp"` e o repositório tem um `server.json`. Instale o `mcp-publisher` e rode `mcp-publisher login github` e depois `mcp-publisher publish`. Mantenha a mesma versão no `package.json` e no `server.json`.
4. **Diretórios (opcional):** Smithery, Glama, mcp.so e as galerias de MCP do Cursor e do VS Code podem listar o servidor a partir do pacote npm ou do registro.

Como o pedal é um aparelho USB local, este é um servidor **local (stdio)**. Clientes que só aceitam servidores remotos precisariam de um transporte HTTP rodando no PC do pedal, exposto por um túnel seguro. Isso ainda não está incluído.

## Licença

[MIT](LICENSE) © Cayo Aguiar. M-VAVE, Tank-G, M-EFCS e TONE3000 são marcas de seus respectivos donos.
