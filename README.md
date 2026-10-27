# MOCI — Mapa de Ocupações Contra Incêndio

Mapa das ocupações vistoriadas pelo **CAT Sertão** (Centro de Atividades
Técnicas do Sertão — CBMPE). Para cada ocupação, mostra a reserva técnica de
incêndio (RTI), os hidrantes, os sprinklers, a caldeira e a validade do AVCB.

- **Site:** https://catsertao.github.io/moci-catsertao/
- **Mapa e lista de ocupações (com a distância até cada ponto):** públicos,
  sem login. Desde 22/10/2026.
- **Cadastro, edição, exclusão, exportação para Excel e administração:**
  exigem login. O login é do próprio MOCI, com usuários próprios.

## Estrutura

| Arquivo | O que é |
|---|---|
| `index.html` + `app.js` | Mapa (Leaflet), cadastro e edição de ocupações. |
| `listar.html` | Lista de ocupações (busca, filtros, exportação). |
| `usuarios.html` | Gestão de usuários (administradores). |
| `conta.html` | Minha conta: troca de senha. |
| `log.html` | LOG de auditoria (só o administrador geral). |
| `apresentacoes.html` | Apresentações do MOCI para grupamentos e para diretores (só o administrador geral). A apresentação animada abre no site `catsertao.github.io/moci-apresentacao`, com o conteúdo cifrado; a chave nunca entra neste repositório. Os demais links levam ao Google Drive pessoal e ao claude.ai do administrador, que só o dono abre. |
| `auth.js` | Login, sessão, menu do usuário e endereço da API (`API_URL`). |
| `style.css` | Estilos de todas as páginas. |
| `apps-script/` | Backend em Google Apps Script (`Code.gs`, `Auth.gs`, `appsscript.json`). |
| `.clasp.json` | Liga a pasta `apps-script/` ao projeto Apps Script (via [clasp](https://github.com/google/clasp)). |

## Backend (Google Apps Script)

O backend é um projeto Apps Script **ligado à planilha "MOCI - Base de
dados"**, no Google Drive da conta institucional do CAT Sertão. A planilha tem
as abas:

- `RTI`: ocupações.
- `USUARIOS`: login, hash da senha com salt, perfil e situação.
- `SESSOES`: sessões de 8 horas.
- `LOG`: auditoria.

O projeto é publicado como **App da Web**: executar como o dono, acesso
"Qualquer pessoa". O endereço `/exec` dessa publicação é o `API_URL` em `auth.js`.

### Atualizar o backend

Com o clasp autenticado na conta dona do projeto:

```bash
clasp push --force
clasp update-deployment <id-da-implantação> --description "o que mudou"
```

Use sempre `update-deployment` com o **mesmo id** que está no `API_URL`.
`clasp create-deployment` cria um endereço novo, e o site para de funcionar
até o `auth.js` ser atualizado. Para ver os ids, use `clasp list-deployments`.

### Instalação do zero (só se um dia for recriar o backend)

1. Crie o projeto e a planilha com
   `clasp create-script --type sheets --title "MOCI" --rootDir apps-script`.
   Depois disso, confira se o `appsscript.json` continua com o fuso
   `America/Recife` e o bloco `webapp`.
2. Rode `clasp push --force`.
3. No editor do Apps Script, abra **Configurações do projeto → Propriedades do
   script** e adicione `SENHA_INICIAL_ADMIN`. A propriedade
   `ADMIN_INICIAL_LOGIN` é opcional (padrão `geraldo.reis`).
4. Rode a função `setupInicial` (arquivo `Auth.gs`) e autorize. Ela:
   - cria as abas;
   - acerta o fuso da planilha;
   - cria o administrador geral;
   - apaga a propriedade da senha.
5. Rode `clasp create-deployment` e coloque o endereço `/exec` no `API_URL`
   do `auth.js`.

## Perfis

| Perfil | Nome no site | Pode |
|---|---|---|
| (sem login) | Visitante | Ver o mapa e a lista, com filtros e distâncias. Não vê quem cadastrou, não exporta, não cadastra nem edita. |
| `admin_master` | Administrador geral | Tudo: cadastrar, editar e excluir ocupações; gerenciar **qualquer** usuário; ver o LOG e as apresentações do MOCI. |
| `admin` | Administrador | Cadastrar, editar e excluir ocupações; gerenciar só vistoriadores e consultas. |
| `user1` | Vistoriador | Cadastrar e listar ocupações (não edita nem exclui). |
| `user2` | Consulta | Só listar. |

Regras de usuários:

- Um usuário só pode ser excluído **depois de desativado**. Ninguém exclui
  nem desativa a própria conta.
- Trocar a senha encerra as sessões em outros aparelhos.
- O botão **Editar**, ao lado do login, muda o login, o perfil ou a senha de
  quem o administrador pode gerenciar (o admin, só vistoriadores e consultas).
  Serve para quem esqueceu a senha. A própria conta se muda em "Minha conta".
  Salvar encerra as sessões abertas da pessoa, e a senha nova desfaz o
  bloqueio por senhas erradas.
- O site encerra a sessão depois de **30 minutos sem uso**. No servidor, a
  sessão vale 8 horas.
- Cinco senhas erradas seguidas bloqueiam o login por 15 minutos.

## Campos do cadastro e cor do marcador

O cadastro tem:

- nome;
- endereço (rua, número ou "NI", bairro, cidade);
- capacidade da RTI (litros);
- hidrante de fachada e de recalque;
- sprinklers e caldeira;
- AVCB com data de validade;
- pavimentos, área construída e altura (opcionais).

### As 3 abas do "Cadastrar ocupação"

Todos os perfis que cadastram (Vistoriador, Administrador e Administrador
geral) veem as três abas. A edição de uma ocupação existente continua sem
abas, com o ponto ajustável no mapa.

1. **Documentos** (aberta por padrão), para o cadastro à distância:
   - O militar envia o **Memorial descritivo (PDF)**, que é obrigatório, e o
     **AVCB (PDF)**, se houver. Cada arquivo pode ter até 5 MB.
   - Depois digita as **coordenadas em graus decimais com 6 casas**
     (precisão de cerca de 0,1 m). Colar `lat, lng` do Google Maps preenche
     os dois campos.
   - O sistema avisa quando o ponto fica fora de Pernambuco, quando latitude
     e longitude estão trocadas e quando já existe ocupação a menos de 30 m.
     Um mini-mapa com modo satélite mostra o ponto.
   - Em **"Ler documentos"**, a IA lê os PDFs e o formulário abaixo abre
     preenchido, com avisos (AVCB vencido, memorial sem carimbo, imóveis
     diferentes etc.). O militar confere e salva.
   - **Os PDFs não ficam guardados em lugar nenhum.**
2. **GPS do celular:** cadastro no local, como antes.
3. **Preencher tudo:** ponto marcado no mapa e todos os campos digitados.

O LOG `cadastro_rti` registra por qual aba a ocupação entrou ("via
documentos", "via GPS" ou "via mapa").

#### Leitura dos documentos (n8n + OpenAI)

A leitura é feita pelo fluxo **"MOCI - Leitura de Documentos"** no n8n
(webhook `moci-leitura-documentos`), com a credencial da OpenAI que **fica
só no n8n**. Nenhuma chave fica neste repositório nem no Apps Script.

1. O site manda os PDFs ao webhook junto com o token de sessão do MOCI.
2. O n8n chama a ação `autorizarLeituraDocumentos` (`Documentos.gs`), que:
   - confere o login e o perfil;
   - aplica o **limite de 20 leituras por usuário por dia**;
   - registra `leitura_documentos` no LOG.
3. O n8n chama a OpenAI (Responses API, saída em JSON com schema estrito)
   e devolve os campos para o formulário.

Outras regras do fluxo:

- **Modelo:** `gpt-5.6-luna`, escolhido em 14/10/2026 nos testes com
  memoriais e AVCBs reais. Foi mais preciso que o `gpt-4o-mini` e custa
  cerca de US$ 0,005 por leitura.
- **Execuções:** o fluxo não guarda execuções no n8n, nem as de erro, porque
  os PDFs passam por ele.
- **Origens aceitas pelo webhook:** `https://catsertao.github.io`, mais o
  servidor local de testes `http://127.0.0.1:8765`.

#### Hidrante, RTI e sprinkler: regras do COSCIP (desde 20/10/2026)

Os dois campos de hidrante do MOCI são as duas formas da tomada de água do
Corpo de Bombeiros (COSCIP, art. 102): o **registro de recalque**, no passeio
(calçada), e o **hidrante de fachada**, na parede ou muro.

| Situação | Regra | Base no COSCIP |
|---|---|---|
| Há RTI ou sistema fixo (hidrante, mangotinho ou chuveiros) | Existe recalque **ou** fachada | Arts. 45, 100, 101, 120 e 128 |
| Recalque × fachada | São **alternativas**; um não implica o outro, e podem coexistir (uma por prumada) | Arts. 101 e 103 |
| RTI × hidrante | RTI **não** implica hidrante: pode servir só a chuveiros automáticos ou a mangotinhos | Arts. 57, §3º, e 105-A |
| Hidrante, mangotinho ou sprinkler | Sempre há RTI | Arts. 53, §2º, 57 e 112, §2º |

Como o sistema aplica essas regras:

- **Leitura por IA:** a IA lê a seção 7 do memorial item a item, cada um como
  está escrito:
  - 7.1.1 Recalque e 7.1.2 Fachada, com a "Localização";
  - 7.2 Mangotinho;
  - 7.3 Hidrante;
  - os volumes da 7.6, sem somar.

  As regras ficam no código do nó "Montar resposta", não na IA:
  - o código **soma a RTI** (m³ → litros);
  - se há RTI ou sistema fixo e o memorial não diz qual ligação existe, o
    código **marca recalque** (a regra do art. 100) e avisa para conferir. A
    "Localização" desempata: "parede" ou "muro" marca fachada;
  - avisa quando há sistema fixo sem volume de RTI e quando a soma fica fora
    de 3.600 a 1.000.000 L (provável erro de unidade).
- **Formulário (todas as abas e a edição):** pede confirmação antes de salvar
  em dois casos:
  - RTI sem nenhum hidrante marcado;
  - hidrante ou sprinkler marcado com RTI 0.

  A confirmação cita o artigo, e o prédio irregular continua cadastrável.
- **Chat do n8n** ("OCI - Diálogo de Cadastro" e "OCI - Nova Planilha"): faz
  as mesmas duas perguntas de coerência, e a resposta repetida vale como
  confirmação.

#### Nome fantasia, proteção do memorial e seção 9 (desde 20/10/2026)

- **Nome no mapa:** "Nome fantasia (Razão social)".
  - O formulário tem os dois campos e uma opção "Não tem nome fantasia: usar a
    razão social". Sem nome fantasia e sem essa opção marcada, o cadastro não
    salva.
  - Na edição de uma ocupação antiga (nome sem parênteses), o nome entra como
    razão social, com a opção marcada.
- **De onde vem o nome fantasia na leitura:**
  1. a linha "Nome Fantasia:" do AVCB, só se for do mesmo imóvel do memorial;
  2. o "Complemento" do endereço do memorial, se for claramente o nome do
     estabelecimento (ex.: "Shopping Salgueiro");
  3. na falta dos dois, a **Receita Federal** pelo CNPJ do memorial (BrasilAPI,
     dados públicos). CPF nunca é consultado.

  O memorial do SACBM só tem a razão social (item 2.2).
- **Proteção:** no cadastro pela aba Documentos, mudar o que o memorial informa
  pede confirmação ao salvar, mostrando o que o memorial diz. Vale para:
  - hidrante de recalque (item 7.1.1);
  - hidrante de fachada (item 7.1.2);
  - sprinklers (seção 8);
  - capacidade da RTI.

  O recalque marcado pelo sistema por presunção não conta como dado do
  memorial. A proteção foi criada depois de 14 cadastros em que "fachada" foi
  marcada à mão quando o memorial só tinha recalque.
- **Seção 9 do memorial:** as opções 9.1.1 (hidrantes e chuveiros), 9.1.2 (só
  hidrantes) e 9.1.3 (só chuveiros) se excluem, e só uma marcada "Sim" é normal.
  A IA foi instruída a não apontar isso como conflito, e observações sobre a
  seção 9 são descartadas no código.

A comparação com o que o COSCIP **exige** pela tabela da triagem (arts. 105-A
e 132-A) ficou de fora de propósito. Muitos prédios foram aprovados antes de
27/05/2025, sob os arts. 105 e 132, hoje revogados, e o MOCI registra o que
**existe**.

A cor do marcador é calculada a cada carregamento:

- 🟢 **Verde:** a ocupação possui AVCB e a validade é hoje ou uma data futura.
- 🔴 **Vermelho:** a ocupação não possui AVCB, ou a validade já passou.

O mapa e a lista públicos não mostram quem cadastrou (`cadastrado_por`).
Sem login, a lista usa a mesma leitura pública do mapa (`doGet`). Com login,
ela usa a ação `listarRTIs`, que traz essa coluna, assim como o LOG. A
mudança de 22/10/2026 foi só no site: o servidor continua exigindo sessão e
perfil para cadastrar, editar e excluir.

## Datas e fuso horário

A planilha usa o fuso `America/Recife`. As colunas de data ficam em
**formato texto**:

- `timestamp` e `data_validade_avcb`, na aba RTI;
- `criado_em` e `expira_em`, nas abas de usuários e sessões;
- `timestamp`, no LOG.

O valor guardado é exatamente o que foi gravado (ISO ou AAAA-MM-DD). Sem
isso, uma planilha num fuso diferente do script devolve as datas
deslocadas: horas no cadastro e um dia na validade do AVCB. Quem cuida
disso é a função `configurarPlanilha_()` (`Auth.gs`).

## Integrações

O chat de cadastro por memorial (n8n) usa as ações `login`, `listarRTIs` e
`cadastrarRTI` da API, com um usuário próprio de serviço. Os nomes internos
"RTI" (aba, ações e funções) foram mantidos de propósito por causa dessa
integração.

## Testar localmente

```bash
npx serve .
```

Abra o endereço mostrado (ex.: `http://localhost:3000`). O site local usa a
mesma API e a mesma planilha da produção: cadastros feitos em teste aparecem
no mapa de verdade e precisam ser apagados depois.

## Observações

- A geolocalização exige HTTPS (o GitHub Pages já usa) ou `localhost`.
- O endereço a partir das coordenadas vem do Nominatim (OpenStreetMap), que
  limita as requisições por segundo. Use com moderação.
