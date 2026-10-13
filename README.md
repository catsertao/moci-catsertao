# MOCI — Mapa de Ocupações Contra Incêndio

Mapa das ocupações vistoriadas pelo **CAT Sertão** (Centro de Atividades
Técnicas do Sertão — CBMPE). Para cada ocupação, mostra a reserva técnica de
incêndio (RTI), os hidrantes, os sprinklers, a caldeira e a validade do AVCB.

- **Site:** https://catsertao.github.io/moci-catsertao/
- **Mapa:** público, sem login.
- **Lista, cadastro, edição e administração:** exigem login. O login é do
  próprio MOCI, com usuários próprios.

## Estrutura

| Arquivo | O que é |
|---|---|
| `index.html` + `app.js` | Mapa (Leaflet), cadastro e edição de ocupações. |
| `listar.html` | Lista de ocupações (busca, filtros, exportação). |
| `usuarios.html` | Gestão de usuários (administradores). |
| `conta.html` | Minha conta: troca de senha. |
| `log.html` | LOG de auditoria (só o administrador geral). |
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
| `admin_master` | Administrador geral | Tudo: cadastrar, editar e excluir ocupações; gerenciar **qualquer** usuário; ver o LOG. |
| `admin` | Administrador | Cadastrar, editar e excluir ocupações; gerenciar só vistoriadores e consultas. |
| `user1` | Vistoriador | Cadastrar e listar ocupações (não edita nem exclui). |
| `user2` | Consulta | Só listar. |

Regras de usuários:

- Um usuário só pode ser excluído **depois de desativado**. Ninguém exclui
  nem desativa a própria conta.
- Trocar a senha encerra as sessões em outros aparelhos.
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

A localização vem do GPS ou é marcada no mapa.

A cor do marcador é calculada a cada carregamento:

- 🟢 **Verde:** a ocupação possui AVCB e a validade é hoje ou uma data futura.
- 🔴 **Vermelho:** a ocupação não possui AVCB, ou a validade já passou.

O mapa público não mostra quem cadastrou (`cadastrado_por`); isso fica na
lista (com login) e no LOG.

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
