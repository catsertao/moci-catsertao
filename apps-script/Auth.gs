/**
 * MOCI — Mapa de Ocupações Contra Incêndio (CAT Sertão / CBMPE)
 * Autenticação, autorização e auditoria.
 *
 * Todas as senhas e tokens são validados aqui, no servidor. O site (público,
 * no GitHub Pages) nunca recebe nem guarda hash de senha — só o token de
 * sessão, que expira sozinho.
 *
 * Perfis e o que cada um pode fazer:
 *   admin_master — tudo: cadastrar/editar/excluir ocupações, gerenciar
 *                  QUALQUER usuário (inclusive outros admins), ver o LOG.
 *   admin        — cadastrar/editar/excluir ocupações; criar/desativar apenas
 *                  user1/user2 (nunca admin ou admin_master).
 *   user1        — cadastrar e listar/filtrar ocupações (sem editar).
 *   user2        — apenas listar/filtrar ocupações.
 */

var SESSAO_HORAS = 8;
var LOGIN_MAX_TENTATIVAS = 5;
var LOGIN_BLOQUEIO_MINUTOS = 15;

var PERFIS_VALIDOS = ['admin_master', 'admin', 'user1', 'user2'];

// ===================== Planilhas auxiliares =====================
function ensureSheet_(nome, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(nome);
  if (!sheet) sheet = ss.insertSheet(nome);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  }
  return sheet;
}

function sheetRowsAsObjects_(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  return values.slice(1).map(function (row, idx) {
    var obj = { _row: idx + 2 }; // linha real na planilha (1-based, +1 pelo cabeçalho)
    headers.forEach(function (h, i) { obj[h] = row[i]; });
    return obj;
  });
}

// ===================== Hash de senha =====================
function gerarSalt_() {
  return Utilities.getUuid();
}

// Milhares de rodadas de SHA-256 (mesma ideia de PBKDF2, sem depender de uma
// lib externa que o Apps Script não tem nativamente) — encarece um ataque de
// força bruta offline caso os hashes algum dia vazem. Usado para toda senha
// nova ou alterada a partir de agora.
//
// Reduzido de 3000 para 1500 em 29/07/2026: medimos ~2,2-2,4s de latência
// pura do Apps Script por chamada (fora do nosso controle), e as 3000
// rodadas somavam uma fatia perceptível em cima disso no login. 1500 ainda é
// uma margem confortável contra força bruta offline; se ficar lento de novo,
// pode baixar mais — se quiser mais margem e o login continuar rápido, pode
// subir.
var HASH_ITERACOES = 1500;

function hashSenha_(senha, salt) {
  return hashSenhaComIteracoes_(senha, salt, HASH_ITERACOES);
}

function hashSenhaComIteracoes_(senha, salt, iteracoes) {
  var valor = salt + senha;
  for (var i = 0; i < iteracoes; i++) {
    valor = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, valor));
  }
  return valor;
}

// ===================== Log de auditoria =====================
function registrarLog_(login, perfil, acao, detalhe) {
  var sheet = ensureSheet_('LOG', ['timestamp', 'login', 'perfil', 'acao', 'detalhe']);
  sheet.appendRow([new Date().toISOString(), login || '', perfil || '', acao, detalhe || '']);
}

// ===================== Sessões =====================
// Trava (LockService) em volta da limpeza + gravação: sem ela, dois logins
// quase simultâneos (dois usuários, ou duas abas) podiam se atropelar --
// uma execução lia a planilha, decidia quais linhas manter, e gravava por
// cima bem na hora que a outra também estava lendo/gravando, perdendo o
// token que a outra tinha acabado de criar. Mesmo padrão de comTravaRTI_
// (Code.gs).
function criarSessao_(login, perfil) {
  var sheet = ensureSheet_('SESSOES', ['token', 'login', 'perfil', 'criado_em', 'expira_em']);
  var token = Utilities.getUuid();

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    limparSessoesExpiradas_(sheet);
    var agora = new Date();
    var expira = new Date(agora.getTime() + SESSAO_HORAS * 3600 * 1000);
    sheet.appendRow([token, login, perfil, agora.toISOString(), expira.toISOString()]);
  } finally {
    lock.releaseLock();
  }

  return token;
}

// Le a planilha uma vez, filtra em memoria, e regrava so as linhas vivas --
// em vez de deletar linha por linha, que e uma chamada de API separada por
// linha expirada; como a limpeza so roda oportunisticamente no login de
// outra pessoa, o numero de linhas expiradas podia crescer bastante entre
// limpezas, deixando o login (e, por tabela, toda acao autenticada -- ver
// obterSessao_, que le esta mesma planilha inteira a cada chamada) cada vez
// mais lento, ate estourar timeout (2026-08-05).
//
// IMPORTANTE: as linhas vivas sao gravadas por cima das posicoes 2..N (nunca
// um clearContents() da planilha inteira antes) e so o excedente no final e
// removido via deleteRows (uma chamada so, nao linha a linha). Isso evita
// que a planilha fique momentaneamente vazia/inconsistente para uma leitura
// concorrente de obterSessao_ (chamada por toda acao autenticada, sem
// trava) enquanto a limpeza esta em andamento.
function limparSessoesExpiradas_(sheet) {
  var values = sheet.getDataRange().getValues();
  var agora = new Date();
  var header = values[0];
  var vivas = [];
  for (var i = 1; i < values.length; i++) {
    var expiraEm = new Date(values[i][4]);
    if (!isNaN(expiraEm.getTime()) && expiraEm >= agora) vivas.push(values[i]);
  }

  var linhasAntigas = values.length - 1;
  if (vivas.length === linhasAntigas) return; // nada expirado, nada a fazer

  if (vivas.length > 0) {
    sheet.getRange(2, 1, vivas.length, header.length).setValues(vivas);
  }
  var linhasSobrando = linhasAntigas - vivas.length;
  if (linhasSobrando > 0) {
    sheet.deleteRows(vivas.length + 2, linhasSobrando);
  }
}

function obterSessao_(token) {
  if (!token) return null;
  var sheet = ensureSheet_('SESSOES', ['token', 'login', 'perfil', 'criado_em', 'expira_em']);
  var rows = sheetRowsAsObjects_(sheet);
  var agora = new Date();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].token === token) {
      var expiraEm = new Date(rows[i].expira_em);
      if (isNaN(expiraEm.getTime()) || expiraEm < agora) return null;
      return { login: rows[i].login, perfil: rows[i].perfil, _row: rows[i]._row };
    }
  }
  return null;
}

function encerrarSessao_(token) {
  var sheet = ensureSheet_('SESSOES', ['token', 'login', 'perfil', 'criado_em', 'expira_em']);
  var rows = sheetRowsAsObjects_(sheet);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].token === token) {
      sheet.deleteRow(rows[i]._row);
      return;
    }
  }
}

// Usado ao desativar um usuário: sem isso, um token já emitido continuaria
// válido até expirar sozinho (até 8h depois), mesmo com o usuário desativado.
function encerrarSessoesDoUsuario_(login) {
  var sheet = ensureSheet_('SESSOES', ['token', 'login', 'perfil', 'criado_em', 'expira_em']);
  var rows = sheetRowsAsObjects_(sheet);
  var loginNorm = String(login || '').trim().toLowerCase();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].login).trim().toLowerCase() === loginNorm) {
      sheet.deleteRow(rows[i]._row);
    }
  }
}

/**
 * Exige uma sessão válida e, opcionalmente, um dos perfis em perfisPermitidos.
 * Retorna { erro: '...' } ou { login, perfil }.
 */
function exigirSessao_(token, perfisPermitidos) {
  var sessao = obterSessao_(token);
  if (!sessao) return { erro: 'Sessão inválida ou expirada. Faça login novamente.' };
  if (perfisPermitidos && perfisPermitidos.indexOf(sessao.perfil) === -1) {
    return { erro: 'Você não tem permissão para essa ação.' };
  }
  return sessao;
}

// ===================== Usuários =====================
function usuariosSheet_() {
  return ensureSheet_('USUARIOS', ['login', 'hash_senha', 'salt', 'perfil', 'criado_por', 'criado_em', 'ativo']);
}

function buscarUsuario_(login) {
  var rows = sheetRowsAsObjects_(usuariosSheet_());
  var loginNorm = String(login || '').trim().toLowerCase();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].login).trim().toLowerCase() === loginNorm) return rows[i];
  }
  return null;
}

function usuarioAtivo_(usuario) {
  return usuario && (usuario.ativo === true || String(usuario.ativo).toUpperCase() === 'TRUE');
}

// admin_master pode criar/gerenciar qualquer perfil, inclusive outro admin.
// admin só pode criar/gerenciar user1 e user2. Nunca cria admin/admin_master.
function podeGerenciarPerfil_(perfilAtor, perfilAlvo) {
  if (perfilAtor === 'admin_master') return true;
  if (perfilAtor === 'admin') return perfilAlvo === 'user1' || perfilAlvo === 'user2';
  return false;
}

// ===================== Handlers (chamados pelo doPost em Code.gs) =====================

function handleLogin_(body) {
  var login = String(body.login || '').trim().toLowerCase();
  var senha = String(body.senha || '');

  if (!login || !senha) {
    return { ok: false, error: 'Informe usuário e senha.' };
  }

  var cache = CacheService.getScriptCache();
  var chaveTentativas = 'login_tentativas_' + login;
  var tentativas = Number(cache.get(chaveTentativas) || 0);
  if (tentativas >= LOGIN_MAX_TENTATIVAS) {
    return { ok: false, error: 'Muitas tentativas incorretas. Tente novamente em alguns minutos.' };
  }

  var usuario = buscarUsuario_(login);
  if (!usuario || !usuarioAtivo_(usuario)) {
    cache.put(chaveTentativas, String(tentativas + 1), LOGIN_BLOQUEIO_MINUTOS * 60);
    registrarLog_(login, '', 'login_falho', 'usuário inexistente ou inativo');
    return { ok: false, error: 'Usuário ou senha incorretos.' };
  }

  var senhaConfere = hashSenha_(senha, usuario.salt) === usuario.hash_senha;
  if (!senhaConfere) {
    cache.put(chaveTentativas, String(tentativas + 1), LOGIN_BLOQUEIO_MINUTOS * 60);
    registrarLog_(login, usuario.perfil, 'login_falho', 'senha incorreta');
    return { ok: false, error: 'Usuário ou senha incorretos.' };
  }

  cache.remove(chaveTentativas);
  var token = criarSessao_(usuario.login, usuario.perfil);
  registrarLog_(usuario.login, usuario.perfil, 'login', '');
  return { ok: true, token: token, login: usuario.login, perfil: usuario.perfil };
}

function handleLogout_(body) {
  var sessao = obterSessao_(body.token);
  if (sessao) registrarLog_(sessao.login, sessao.perfil, 'logout', '');
  encerrarSessao_(body.token);
  return { ok: true };
}

function handleValidarToken_(body) {
  var sessao = obterSessao_(body.token);
  if (!sessao) return { ok: false };
  return { ok: true, login: sessao.login, perfil: sessao.perfil };
}

function handleListarUsuarios_(body) {
  var sessao = exigirSessao_(body.token, ['admin_master', 'admin']);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var rows = sheetRowsAsObjects_(usuariosSheet_());
  var usuarios = rows.map(function (u) {
    return {
      login: u.login,
      perfil: u.perfil,
      criado_por: u.criado_por,
      criado_em: u.criado_em,
      ativo: usuarioAtivo_(u)
    };
  });
  return { ok: true, usuarios: usuarios };
}

function handleCriarUsuario_(body) {
  var sessao = exigirSessao_(body.token, ['admin_master', 'admin']);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var login = String(body.login || '').trim().toLowerCase();
  var senha = String(body.senha || '');
  var perfil = String(body.perfil || '');

  if (!login || !senha || !perfil) {
    return { ok: false, error: 'Preencha login, senha e perfil.' };
  }
  if (PERFIS_VALIDOS.indexOf(perfil) === -1) {
    return { ok: false, error: 'Perfil inválido.' };
  }
  if (senha.length < 6) {
    return { ok: false, error: 'A senha deve ter pelo menos 6 caracteres.' };
  }
  if (!podeGerenciarPerfil_(sessao.perfil, perfil)) {
    return { ok: false, error: 'Você não tem permissão para criar um usuário com esse perfil.' };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (buscarUsuario_(login)) {
      return { ok: false, error: 'Já existe um usuário com esse login.' };
    }
    var salt = gerarSalt_();
    var hash = hashSenha_(senha, salt);
    usuariosSheet_().appendRow([login, hash, salt, perfil, sessao.login, new Date().toISOString(), true]);
  } finally {
    lock.releaseLock();
  }

  registrarLog_(sessao.login, sessao.perfil, 'criacao_usuario', 'criou "' + login + '" (' + perfil + ')');
  return { ok: true };
}

function handleDesativarUsuario_(body) {
  var sessao = exigirSessao_(body.token, ['admin_master', 'admin']);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var loginAlvo = String(body.login || '').trim().toLowerCase();
  if (loginAlvo === sessao.login) {
    return { ok: false, error: 'Você não pode desativar sua própria conta.' };
  }
  var usuario = buscarUsuario_(loginAlvo);
  if (!usuario) return { ok: false, error: 'Usuário não encontrado.' };
  if (!podeGerenciarPerfil_(sessao.perfil, usuario.perfil)) {
    return { ok: false, error: 'Você não tem permissão para desativar esse usuário.' };
  }

  usuariosSheet_().getRange(usuario._row, 7).setValue(false); // coluna "ativo"
  encerrarSessoesDoUsuario_(loginAlvo);
  registrarLog_(sessao.login, sessao.perfil, 'desativacao_usuario', 'desativou "' + loginAlvo + '"');
  return { ok: true };
}

function handleReativarUsuario_(body) {
  var sessao = exigirSessao_(body.token, ['admin_master', 'admin']);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var loginAlvo = String(body.login || '').trim().toLowerCase();
  var usuario = buscarUsuario_(loginAlvo);
  if (!usuario) return { ok: false, error: 'Usuário não encontrado.' };
  if (!podeGerenciarPerfil_(sessao.perfil, usuario.perfil)) {
    return { ok: false, error: 'Você não tem permissão para reativar esse usuário.' };
  }

  usuariosSheet_().getRange(usuario._row, 7).setValue(true); // coluna "ativo"
  registrarLog_(sessao.login, sessao.perfil, 'reativacao_usuario', 'reativou "' + loginAlvo + '"');
  return { ok: true };
}

// Exclusão definitiva. Só é permitida para usuários já desativados — força
// passar por "Desativar" antes, evitando remover por engano uma conta em uso
// (a sessão ativa, se houver, já foi encerrada no momento da desativação).
// Apagar a linha não quebra o LOG nem a coluna "cadastrado_por" da aba RTI:
// os dois guardam o login como texto (um retrato do momento), não uma
// referência viva ao cadastro do usuário.
function handleExcluirUsuario_(body) {
  var sessao = exigirSessao_(body.token, ['admin_master', 'admin']);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var loginAlvo = String(body.login || '').trim().toLowerCase();
  if (loginAlvo === sessao.login) {
    return { ok: false, error: 'Você não pode excluir sua própria conta.' };
  }
  var usuario = buscarUsuario_(loginAlvo);
  if (!usuario) return { ok: false, error: 'Usuário não encontrado.' };
  if (!podeGerenciarPerfil_(sessao.perfil, usuario.perfil)) {
    return { ok: false, error: 'Você não tem permissão para excluir esse usuário.' };
  }
  if (usuarioAtivo_(usuario)) {
    return { ok: false, error: 'Desative o usuário antes de excluí-lo definitivamente.' };
  }

  usuariosSheet_().deleteRow(usuario._row);
  registrarLog_(sessao.login, sessao.perfil, 'exclusao_usuario', 'excluiu "' + loginAlvo + '" (' + usuario.perfil + ')');
  return { ok: true };
}

function handleAlterarSenha_(body) {
  var sessao = exigirSessao_(body.token, null);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var senhaAtual = String(body.senhaAtual || '');
  var senhaNova = String(body.senhaNova || '');
  if (senhaNova.length < 6) {
    return { ok: false, error: 'A nova senha deve ter pelo menos 6 caracteres.' };
  }

  var usuario = buscarUsuario_(sessao.login);
  if (!usuario) return { ok: false, error: 'Usuário não encontrado.' };
  var senhaAtualConfere = hashSenha_(senhaAtual, usuario.salt) === usuario.hash_senha;
  if (!senhaAtualConfere) {
    return { ok: false, error: 'Senha atual incorreta.' };
  }

  var novoSalt = gerarSalt_();
  var novoHash = hashSenha_(senhaNova, novoSalt);
  var sheet = usuariosSheet_();
  sheet.getRange(usuario._row, 2).setValue(novoHash); // hash_senha
  sheet.getRange(usuario._row, 3).setValue(novoSalt); // salt

  // Encerra QUALQUER sessão ativa desse login (inclusive a atual) — é o
  // comportamento certo para "esqueci a senha em algum lugar" ou "acho que
  // minha conta foi comprometida": trocar a senha derruba todo mundo. Na
  // sequência, emite um token novo só para este dispositivo, pra quem
  // acabou de trocar a própria senha de propósito não precisar logar de
  // novo na hora.
  encerrarSessoesDoUsuario_(sessao.login);
  var novoToken = criarSessao_(sessao.login, sessao.perfil);

  registrarLog_(sessao.login, sessao.perfil, 'alteracao_senha', 'encerrou sessoes em outros dispositivos');
  return { ok: true, token: novoToken };
}

// Registros por página aceitos pelo front-end (log.html) — qualquer outro
// valor (ausente, inválido, ou um número fora dessa lista) cai no padrão de
// 10. Limitar aqui, no servidor, é o que realmente evita sobrecarregar a
// página: só as N linhas da página pedida (já filtradas) chegam a trafegar e
// a serem desenhadas na tabela, mesmo que o LOG tenha milhares de registros.
var LOG_LIMITES_PERMITIDOS = [10, 50, 100];
var LOG_LIMITE_PADRAO = 10;

function handleListarLog_(body) {
  var sessao = exigirSessao_(body.token, ['admin_master']);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var rows = sheetRowsAsObjects_(ensureSheet_('LOG', ['timestamp', 'login', 'perfil', 'acao', 'detalhe']));
  var acaoFiltro = body.acao || '';
  var dataInicio = body.dataInicio ? new Date(body.dataInicio) : null;
  var dataFim = body.dataFim ? new Date(body.dataFim) : null;
  var buscaFiltro = String(body.busca || '').trim().toLowerCase();

  var limite = Number(body.limite);
  if (LOG_LIMITES_PERMITIDOS.indexOf(limite) === -1) limite = LOG_LIMITE_PADRAO;

  // 1-based, como no front-end. Sem paginaAtual válida (ausente, zero,
  // negativa, fracionária) cai na primeira página -- mesmo comportamento de
  // antes desta mudança, quando só existia "os N mais recentes".
  var pagina = Math.floor(Number(body.pagina));
  if (!pagina || pagina < 1) pagina = 1;

  var filtrado = rows.filter(function (r) {
    if (acaoFiltro && r.acao !== acaoFiltro) return false;
    var ts = new Date(r.timestamp);
    if (dataInicio && ts < dataInicio) return false;
    if (dataFim && ts > dataFim) return false;
    if (buscaFiltro) {
      var alvo = [r.login, r.perfil, r.acao, r.detalhe].join(' ').toLowerCase();
      if (alvo.indexOf(buscaFiltro) === -1) return false;
    }
    return true;
  }).map(function (r) {
    return { timestamp: r.timestamp, login: r.login, perfil: r.perfil, acao: r.acao, detalhe: r.detalhe };
  }).reverse(); // mais recentes primeiro

  var total = filtrado.length;
  var inicio = (pagina - 1) * limite;
  var paginaRows = filtrado.slice(inicio, inicio + limite);

  return { ok: true, log: paginaRows, total: total, limite: limite, pagina: pagina };
}

// Fuso e formato das colunas de data. Uma planilha nova nasce com o fuso da
// conta Google, que pode não ser o de Pernambuco; com fusos diferentes entre
// planilha e script, as datas voltam deslocadas (horas no timestamp, um dia
// na validade do AVCB). As colunas de data ficam como TEXTO: guardam
// exatamente o ISO/AAAA-MM-DD gravado, sem conversão automática do Sheets.
var FUSO_MOCI = 'America/Recife';
var COLUNAS_DATA_TEXTO = {
  RTI: ['timestamp', 'data_validade_avcb'],
  USUARIOS: ['criado_em'],
  SESSOES: ['criado_em', 'expira_em'],
  LOG: ['timestamp']
};

// Devolve o fuso que a planilha tinha antes (para o registro de execução).
function configurarPlanilha_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var fusoAnterior = ss.getSpreadsheetTimeZone();
  Object.keys(COLUNAS_DATA_TEXTO).forEach(function (nome) {
    var sheet = ss.getSheetByName(nome);
    if (!sheet || sheet.getMaxRows() < 2) return;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    COLUNAS_DATA_TEXTO[nome].forEach(function (h) {
      var col = headers.indexOf(h) + 1;
      if (!col) return;
      var faixa = sheet.getRange(2, col, sheet.getMaxRows() - 1, 1);
      // Células que o Sheets já converteu em data voltam a ser texto ISO
      // (lidas ANTES de mudar o fuso, para manter o instante gravado).
      var valores = faixa.getValues();
      var convertidas = false;
      valores.forEach(function (linha) {
        if (Object.prototype.toString.call(linha[0]) === '[object Date]') {
          linha[0] = h === 'data_validade_avcb'
            ? Utilities.formatDate(linha[0], fusoAnterior, 'yyyy-MM-dd')
            : linha[0].toISOString();
          convertidas = true;
        }
      });
      faixa.setNumberFormat('@');
      if (convertidas) faixa.setValues(valores);
    });
  });
  if (fusoAnterior !== FUSO_MOCI) ss.setSpreadsheetTimeZone(FUSO_MOCI);
  return fusoAnterior;
}

/**
 * INSTALAÇÃO — rode esta função UMA VEZ, manualmente, pelo editor do Apps
 * Script (nunca é exposta via doGet/doPost). Cria as abas e o admin_master
 * inicial. A senha vem da propriedade do script "SENHA_INICIAL_ADMIN" e o
 * login de "ADMIN_INICIAL_LOGIN" (padrão: geraldo.reis) — nunca do código.
 * Pode ser rodada de novo sem risco: não duplica nada.
 */
function setupInicial() {
  var props = PropertiesService.getScriptProperties();
  var senhaInicial = props.getProperty('SENHA_INICIAL_ADMIN');
  var loginAdmin = String(props.getProperty('ADMIN_INICIAL_LOGIN') || 'geraldo.reis').trim().toLowerCase();
  if (!senhaInicial) {
    throw new Error(
      'Defina a propriedade do script "SENHA_INICIAL_ADMIN" (Configurações do projeto > ' +
      'Propriedades do script) antes de rodar o setupInicial().'
    );
  }

  rtiSheet_(); // aba de ocupações com todas as colunas (RTI_HEADERS, em Code.gs)
  ensureSheet_('SESSOES', ['token', 'login', 'perfil', 'criado_em', 'expira_em']);
  ensureSheet_('LOG', ['timestamp', 'login', 'perfil', 'acao', 'detalhe']);
  var usuarios = usuariosSheet_();
  configurarPlanilha_();

  if (buscarUsuario_(loginAdmin)) {
    Logger.log('Usuário "' + loginAdmin + '" já existe — admin não recriado.');
  } else {
    var salt = gerarSalt_();
    usuarios.appendRow([loginAdmin, hashSenha_(senhaInicial, salt), salt, 'admin_master', 'setupInicial', new Date().toISOString(), true]);
    registrarLog_(loginAdmin, 'admin_master', 'setup_inicial', 'criação do admin_master inicial');
    Logger.log('admin_master "' + loginAdmin + '" criado. Troque a senha em "Minha conta" após o primeiro login.');
  }
  // A senha inicial não fica guardada depois de usada.
  props.deleteProperty('SENHA_INICIAL_ADMIN');

  // Etapas de migração (arquivo Migracao.gs, temporário — some depois da migração).
  if (typeof migracaoInicial_ === 'function') migracaoInicial_();
}
