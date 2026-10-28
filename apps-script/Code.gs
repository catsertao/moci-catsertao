/**
 * MOCI — Mapa de Ocupações Contra Incêndio (CAT Sertão / CBMPE)
 * Backend em Google Apps Script, ligado à planilha "MOCI - Base de dados".
 *
 * Implantado como App da Web (Executar como: eu / Quem tem acesso: qualquer
 * pessoa). A URL /exec vai em API_URL, no auth.js do site.
 *
 * Autenticação, usuários e auditoria estão em Auth.gs, no mesmo projeto.
 * Os nomes internos ("RTI", cadastrarRTI...) são do protótipo original e
 * foram mantidos de propósito: o chat do n8n também usa essas ações.
 */

var RTI_SHEET_NAME = 'RTI';
var RTI_HEADERS = [
  'timestamp', 'lat', 'lng', 'nome', 'capacidade_litros',
  'hidrante_fachada', 'hidrante_recalque', 'endereco',
  'possui_avcb', 'data_validade_avcb', 'quantidade_pavimentos',
  'area_construida', 'altura_edificacao', 'cadastrado_por',
  // Adicionados para permitir edição (id) e endereço estruturado (rua/número/
  // bairro/cidade), obrigatórios a partir desta versão. Ficam no final da
  // lista de propósito: rtiSheet_() só ADICIONA colunas que faltam, sempre no
  // final da planilha já existente — nunca reordena as colunas atuais.
  'id', 'rua', 'numero', 'bairro', 'cidade',
  // Campo Caldeira: mesmo padrão dos anteriores, adicionado no final para
  // não reordenar planilhas já em produção.
  'possui_caldeira',
  // Sprinklers: pontos sem valor são tratados como "NAO" no front-end.
  'possui_sprinkler',
  // Hidrantes da edificação (item 7.3 do memorial), desde 28/10/2026. Ver
  // migrarHidrantes_.
  'hidrantes_edificacao'
];

// Quem pode cadastrar RTI. Ver a listagem (handleListarRTIs_) é mais aberto —
// inclui também user2 (ver RTI_PERFIS_VISUALIZACAO). Editar é mais restrito
// (ver handleEditarRTI_).
var RTI_PERFIS_CADASTRO = ['admin_master', 'admin', 'user1'];
var RTI_PERFIS_VISUALIZACAO = ['admin_master', 'admin', 'user1', 'user2'];
var RTI_PERFIS_EDICAO = ['admin_master', 'admin'];

function rtiSheet_() {
  var sheet = ensureSheet_(RTI_SHEET_NAME, RTI_HEADERS);

  // Migração: planilhas criadas antes de alguma dessas colunas ganham a(s)
  // coluna(s) que faltarem automaticamente, sem afetar os dados já existentes.
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var adicionadas = [];
  RTI_HEADERS.forEach(function (h) {
    if (headers.indexOf(h) === -1) {
      lastCol += 1;
      sheet.getRange(1, lastCol).setValue(h);
      headers.push(h);
      adicionadas.push(h);
    }
  });
  if (adicionadas.indexOf('hidrantes_edificacao') !== -1) migrarHidrantes_(sheet, headers);

  // Backfill de "id": linhas cadastradas antes dessa coluna existir ficam sem
  // valor. Preenche com um UUID novo na primeira vez que a planilha é aberta
  // depois dessa atualização, para que toda linha tenha um identificador
  // estável usável por handleEditarRTI_.
  var idCol = headers.indexOf('id') + 1;
  var lastRow = sheet.getLastRow();
  if (idCol > 0 && lastRow > 1) {
    var idRange = sheet.getRange(2, idCol, lastRow - 1, 1);
    var idValues = idRange.getValues();
    var mudou = false;
    for (var i = 0; i < idValues.length; i++) {
      if (!idValues[i][0]) {
        idValues[i][0] = Utilities.getUuid();
        mudou = true;
      }
    }
    if (mudou) idRange.setValues(idValues);
  }

  return sheet;
}

// Datas gravadas como texto (ex.: "2026-12-31") às vezes são convertidas
// automaticamente pelo Google Sheets em células do tipo Date. Normaliza de
// volta para 'YYYY-MM-DD' antes de responder, já que o front-end compara
// essa data como texto.
function normalizarDataCelula_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, 'GMT-3', 'yyyy-MM-dd');
  }
  return value;
}

// Migração de 28/10/2026, feita uma vez, quando a coluna "hidrantes_edificacao"
// é criada:
// - recalque e fachada viram um campo só, "Recalque (passeio e/ou fachada)",
//   gravado em hidrante_recalque (COSCIP, art. 101: a fachada é admitida como
//   registro de recalque). A coluna hidrante_fachada fica como histórico;
// - "Hidrantes da edificação" é SIM onde há recalque, por decisão do CAT
//   Sertão: em Pernambuco os projetos usam hidrante, não mangotinho, e as
//   ocupações com sprinkler cadastradas até aqui exigem hidrante (art. 105-A).
function migrarHidrantes_(sheet, headers) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var n = lastRow - 1;
  var colFachada = headers.indexOf('hidrante_fachada') + 1;
  var colRecalque = headers.indexOf('hidrante_recalque') + 1;
  var colHidrantes = headers.indexOf('hidrantes_edificacao') + 1;
  var fachada = sheet.getRange(2, colFachada, n, 1).getValues();
  var recalque = sheet.getRange(2, colRecalque, n, 1).getValues();
  var hidrantes = [];
  var comRecalque = 0;
  for (var i = 0; i < n; i++) {
    var tem = recalque[i][0] === 'SIM' || fachada[i][0] === 'SIM';
    recalque[i][0] = tem ? 'SIM' : 'NAO';
    hidrantes.push([tem ? 'SIM' : 'NAO']);
    if (tem) comRecalque++;
  }
  sheet.getRange(2, colRecalque, n, 1).setValues(recalque);
  sheet.getRange(2, colHidrantes, n, 1).setValues(hidrantes);
  registrarLog_('', '', 'migracao', 'Hidrantes: recalque e fachada unidos em "Recalque (passeio e/ou fachada)"; ' +
    '"Hidrantes da edificação" = SIM em ' + comRecalque + ' de ' + n + ' ocupações (as que têm recalque).');
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Serializa as escritas na aba de OCI. A posição de linha devolvida por
// encontrarLinhaRTIPorId_ é FÍSICA: entre localizar a linha e gravar/apagar
// nela, uma execução concorrente que insira ou remova uma linha ANTES dela
// desloca tudo o que vem depois -- e a gravação cai no registro errado, sem
// erro nenhum. Os handlers de Auth.gs usam o mesmo padrão.
function comTravaRTI_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// O mapa é público: qualquer pessoa pode consultar os pontos de RTI, sem login.
// "cadastrado_por" não entra na resposta pública — é um dado interno (ver LOG
// e handleListarRTIs_, que exige sessão). "id" é incluído: é só um
// identificador opaco, necessário no front-end para o botão de editar que
// aparece no popup do marcador para admin_master/admin.
function doGet(e) {
  var sheet = rtiSheet_();
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var points = [];

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var point = {};
    for (var c = 0; c < headers.length; c++) {
      if (headers[c] === 'cadastrado_por') continue;
      point[headers[c]] = headers[c] === 'data_validade_avcb' ? normalizarDataCelula_(row[c]) : row[c];
    }
    points.push(point);
  }

  return jsonResponse_({ ok: true, points: points });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonResponse_({ ok: false, error: 'JSON inválido.' });
  }

  // O switch PRECISA estar dentro de try/catch. Sem isso, qualquer exceção que
  // escape de um handler faz o Apps Script responder com a PÁGINA DE ERRO HTML
  // dele em vez de JSON, e o front-end quebra com
  // "Unexpected token '<', "<!DOCTYPE "... is not valid JSON" -- sem pista do
  // que houve. Pior: quando a exceção acontece DEPOIS da escrita na planilha, a
  // operação deu certo e mesmo assim o usuário vê erro e a tela não atualiza.
  // Foi o que ocorreu na exclusão do OCI CONDOMINIO BUONA VITA.
  try {
    return despachar_(body);
  } catch (err) {
    var msg = (err && err.message) ? err.message : String(err);
    try {
      registrarLog_('', '', 'erro_backend', 'ação "' + (body.action || '?') + '": ' + msg);
    } catch (e) { /* nunca deixar a falha de LOG mascarar o erro original */ }
    return jsonResponse_({ ok: false, error: 'Erro interno no servidor: ' + msg });
  }
}

function despachar_(body) {
  switch (body.action) {
    case 'login': return jsonResponse_(handleLogin_(body));
    case 'logout': return jsonResponse_(handleLogout_(body));
    case 'validarToken': return jsonResponse_(handleValidarToken_(body));
    case 'listarUsuarios': return jsonResponse_(handleListarUsuarios_(body));
    case 'criarUsuario': return jsonResponse_(handleCriarUsuario_(body));
    case 'desativarUsuario': return jsonResponse_(handleDesativarUsuario_(body));
    case 'reativarUsuario': return jsonResponse_(handleReativarUsuario_(body));
    case 'editarUsuario': return jsonResponse_(handleEditarUsuario_(body));
    case 'excluirUsuario': return jsonResponse_(handleExcluirUsuario_(body));
    case 'alterarSenha': return jsonResponse_(handleAlterarSenha_(body));
    case 'listarLog': return jsonResponse_(handleListarLog_(body));
    case 'cadastrarRTI': return jsonResponse_(handleCadastrarRTI_(body));
    case 'listarRTIs': return jsonResponse_(handleListarRTIs_(body));
    case 'editarRTI': return jsonResponse_(handleEditarRTI_(body));
    case 'excluirRTI': return jsonResponse_(handleExcluirRTI_(body));
    case 'autorizarLeituraDocumentos': return jsonResponse_(handleAutorizarLeituraDocumentos_(body)); // Documentos.gs (chamada pelo n8n)
    default: return jsonResponse_({ ok: false, error: 'Ação inválida.' });
  }
}

// Validação compartilhada por handleCadastrarRTI_ e handleEditarRTI_. Retorna
// os dados já normalizados/prontos para gravar, ou { erro: '...' }.
function validarDadosRTI_(body) {
  var lat = Number(body.lat);
  var lng = Number(body.lng);
  var nome = String(body.nome || '').trim();
  var capacidade = Number(body.capacidade_litros);

  if (!nome || isNaN(lat) || isNaN(lng) || isNaN(capacidade)) {
    return { erro: 'Campos obrigatórios ausentes ou inválidos.' };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { erro: 'Coordenadas inválidas.' };
  }
  if (capacidade < 0) {
    return { erro: 'A capacidade da RTI não pode ser negativa.' };
  }

  // Endereço estruturado, obrigatório desde esta versão (tanto para cadastro
  // via GPS do vistoriador quanto para cadastro/edição manual do admin).
  // "numero" aceita explicitamente "NI" (Não Informado) quando não existir
  // numeração no local.
  var rua = String(body.rua || '').trim();
  var numero = String(body.numero || '').trim();
  var bairro = String(body.bairro || '').trim();
  var cidade = String(body.cidade || '').trim();
  if (!rua || !numero || !bairro || !cidade) {
    return { erro: 'Informe rua, número (ou "NI"), bairro e cidade.' };
  }

  var possuiAvcb = body.possui_avcb === 'SIM';
  var dataValidadeAvcb = String(body.data_validade_avcb || '').trim();
  if (possuiAvcb && !/^\d{4}-\d{2}-\d{2}$/.test(dataValidadeAvcb)) {
    return { erro: 'Informe a data de validade do AVCB (formato inválido).' };
  }

  var pavimentos = body.quantidade_pavimentos === '' || body.quantidade_pavimentos == null
    ? '' : Number(body.quantidade_pavimentos);
  if (pavimentos !== '' && (isNaN(pavimentos) || pavimentos < 1)) {
    return { erro: 'Quantidade de pavimentos inválida.' };
  }

  var area = body.area_construida === '' || body.area_construida == null
    ? '' : Number(body.area_construida);
  if (area !== '' && (isNaN(area) || area < 0)) {
    return { erro: 'Área construída inválida.' };
  }

  var altura = body.altura_edificacao === '' || body.altura_edificacao == null
    ? '' : Number(body.altura_edificacao);
  if (altura !== '' && (isNaN(altura) || altura < 0)) {
    return { erro: 'Altura da edificação inválida.' };
  }

  // Recalque (passeio e/ou fachada): um campo só desde 28/10/2026 (ver
  // migrarHidrantes_). O chat do n8n ainda manda recalque e fachada separados,
  // e não informa os hidrantes da edificação: aí vale a regra da migração.
  var temRecalque = body.hidrante_recalque === 'SIM' || body.hidrante_fachada === 'SIM';
  var hidrantes = body.hidrantes_edificacao === 'SIM' || body.hidrantes_edificacao === 'NAO'
    ? body.hidrantes_edificacao : (temRecalque ? 'SIM' : 'NAO');

  return {
    lat: lat, lng: lng, nome: nome, capacidade: capacidade,
    hidranteRecalque: temRecalque ? 'SIM' : 'NAO',
    hidrantesEdificacao: hidrantes,
    // Histórico: só o chat do n8n ainda informa a fachada separada.
    hidranteFachada: body.hidrante_fachada === 'SIM' || body.hidrante_fachada === 'NAO' ? body.hidrante_fachada : '',
    possuiSprinkler: body.possui_sprinkler === 'SIM' ? 'SIM' : 'NAO',
    possuiCaldeira: body.possui_caldeira === 'SIM' ? 'SIM' : 'NAO',
    rua: rua, numero: numero, bairro: bairro, cidade: cidade,
    endereco: rua + ', ' + numero + ' - ' + bairro + ', ' + cidade,
    possuiAvcb: possuiAvcb ? 'SIM' : 'NAO',
    dataValidadeAvcb: possuiAvcb ? dataValidadeAvcb : '',
    pavimentos: pavimentos, area: area, altura: altura
  };
}

function handleCadastrarRTI_(body) {
  var sessao = exigirSessao_(body.token, RTI_PERFIS_CADASTRO);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var d = validarDadosRTI_(body);
  if (d.erro) return { ok: false, error: d.erro };

  // Mesma trava da edição e da exclusão. appendRow não depende de índice de
  // linha, mas serializar as escritas evita que uma inclusão se intercale com
  // um deleteRow em curso.
  return comTravaRTI_(function () { return gravarCadastroRTI_(body, d, sessao); });
}

function gravarCadastroRTI_(body, d, sessao) {
  var id = Utilities.getUuid();
  var timestamp = body.timestamp || new Date().toISOString();
  var sheet = rtiSheet_();
  // Grava por NOME de coluna (não por posição fixa): em planilhas criadas
  // antes das colunas possui_avcb/quantidade_pavimentos/area_construida/
  // altura_edificacao existirem, "cadastrado_por" ficou "presa" numa posição
  // anterior à dessas colunas (rtiSheet_() só adiciona colunas no fim, nunca
  // reordena as existentes). Um array fixo por posição gravava valores na
  // coluna física errada (ex.: SIM/NÃO do AVCB caindo em "cadastrado_por").
  // Ver mesmo padrão em handleEditarRTI_.
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var novaLinha = headers.map(function (h) {
    switch (h) {
      case 'timestamp': return timestamp;
      case 'lat': return d.lat;
      case 'lng': return d.lng;
      case 'nome': return d.nome;
      case 'capacidade_litros': return d.capacidade;
      case 'hidrante_fachada': return d.hidranteFachada;
      case 'hidrante_recalque': return d.hidranteRecalque;
      case 'hidrantes_edificacao': return d.hidrantesEdificacao;
      case 'possui_sprinkler': return d.possuiSprinkler;
      case 'endereco': return d.endereco;
      case 'possui_avcb': return d.possuiAvcb;
      case 'data_validade_avcb': return d.dataValidadeAvcb;
      case 'quantidade_pavimentos': return d.pavimentos;
      case 'area_construida': return d.area;
      case 'altura_edificacao': return d.altura;
      case 'cadastrado_por': return sessao.login;
      case 'id': return id;
      case 'rua': return d.rua;
      case 'numero': return d.numero;
      case 'bairro': return d.bairro;
      case 'cidade': return d.cidade;
      case 'possui_caldeira': return d.possuiCaldeira;
      default: return '';
    }
  });
  sheet.appendRow(novaLinha);

  // Aba do site usada no cadastro (documentos, gps ou mapa) — só para auditoria.
  var origem = { documentos: 'via documentos', gps: 'via GPS', mapa: 'via mapa' }[body.origem];
  registrarLog_(sessao.login, sessao.perfil, 'cadastro_rti', d.nome + ' (' + d.capacidade + ' L)' + (origem ? ' ' + origem : ''));
  return { ok: true, id: id };
}

// Lista todos os OCIs cadastrados, incluindo quem cadastrou cada um — ao
// contrário do doGet (mapa público), que omite "cadastrado_por". Qualquer
// perfil logado (inclusive user2/Acesso Básico) pode consultar essa
// listagem, mesmo sem poder cadastrar; a edição em si é restrita a
// admin_master/admin (ver abaixo).
function handleListarRTIs_(body) {
  var sessao = exigirSessao_(body.token, RTI_PERFIS_VISUALIZACAO);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var sheet = rtiSheet_();
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var pontos = [];

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var point = {};
    for (var c = 0; c < headers.length; c++) {
      point[headers[c]] = headers[c] === 'data_validade_avcb' ? normalizarDataCelula_(row[c]) : row[c];
    }
    pontos.push(point);
  }

  return { ok: true, points: pontos };
}

function encontrarLinhaRTIPorId_(id) {
  var sheet = rtiSheet_();
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idCol = headers.indexOf('id');
  if (idCol === -1) return null;

  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idCol]) === id) {
      var valores = {};
      headers.forEach(function (h, c) { valores[h] = values[i][c]; });
      return { linha: i + 1, headers: headers, valores: valores };
    }
  }
  return null;
}

// Edição só para admin_master/admin (Reunião com o pedido original: o
// vistoriador — user1 — só cadastra, nunca edita). Preserva "timestamp"
// (data do cadastro original) e "cadastrado_por" (quem cadastrou de fato) —
// a edição não reescreve a autoria, só os dados do ponto. Loga separadamente
// quem editou, em qual RTI, sem apagar o rastro de quem criou.
function handleEditarRTI_(body) {
  var sessao = exigirSessao_(body.token, RTI_PERFIS_EDICAO);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var id = String(body.id || '').trim();
  if (!id) return { ok: false, error: 'RTI não identificado.' };

  var d = validarDadosRTI_(body);
  if (d.erro) return { ok: false, error: d.erro };

  // Localizar a linha e gravar nela têm de acontecer sob a MESMA trava:
  // achado.linha é uma posição física, e a remoção concorrente de qualquer
  // linha anterior a ela desloca o alvo -- fazendo a gravação cair no registro
  // errado, em silêncio.
  return comTravaRTI_(function () { return gravarEdicaoRTI_(id, d, sessao); });
}

function gravarEdicaoRTI_(id, d, sessao) {
  var achado = encontrarLinhaRTIPorId_(id);
  if (!achado) return { ok: false, error: 'RTI não encontrado.' };

  var novaLinha = achado.headers.map(function (h) {
    switch (h) {
      case 'id': return id;
      case 'timestamp': return achado.valores.timestamp;
      case 'lat': return d.lat;
      case 'lng': return d.lng;
      case 'nome': return d.nome;
      case 'capacidade_litros': return d.capacidade;
      // O site não manda mais a fachada separada: mantém o histórico da linha.
      case 'hidrante_fachada': return d.hidranteFachada || achado.valores.hidrante_fachada;
      case 'hidrante_recalque': return d.hidranteRecalque;
      case 'hidrantes_edificacao': return d.hidrantesEdificacao;
      case 'possui_sprinkler': return d.possuiSprinkler;
      case 'endereco': return d.endereco;
      case 'rua': return d.rua;
      case 'numero': return d.numero;
      case 'bairro': return d.bairro;
      case 'cidade': return d.cidade;
      case 'possui_caldeira': return d.possuiCaldeira;
      case 'possui_avcb': return d.possuiAvcb;
      case 'data_validade_avcb': return d.dataValidadeAvcb;
      case 'quantidade_pavimentos': return d.pavimentos;
      case 'area_construida': return d.area;
      case 'altura_edificacao': return d.altura;
      case 'cadastrado_por': return achado.valores.cadastrado_por;
      default: return achado.valores[h];
    }
  });

  rtiSheet_().getRange(achado.linha, 1, 1, achado.headers.length).setValues([novaLinha]);

  registrarLog_(sessao.login, sessao.perfil, 'edicao_rti', 'editou "' + d.nome + '" (id ' + id + ')');
  return { ok: true };
}

// Exclusão definitiva, mesma restrição de perfil da edição (admin_master/
// admin — o vistoriador só cadastra). O nome/endereço são copiados ANTES de
// apagar, para o rastro no LOG não desaparecer junto com a linha.
//
// Idempotente de propósito: excluir algo que já não existe é SUCESSO, não erro.
// A regra antiga devolvia "RTI não encontrado", e isso confundia justamente no
// caso em que mais atrapalha — o usuário cuja primeira tentativa funcionou mas
// teve a resposta perdida, e que tenta de novo achando ter falhado.
function handleExcluirRTI_(body) {
  var sessao = exigirSessao_(body.token, RTI_PERFIS_EDICAO);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var id = String(body.id || '').trim();
  if (!id) return { ok: false, error: 'RTI não identificado.' };

  return comTravaRTI_(function () {
    var achado = encontrarLinhaRTIPorId_(id);
    if (!achado) return { ok: true, jaExcluido: true };

    var nome = achado.valores.nome;
    var cadastradoPor = achado.valores.cadastrado_por;

    // Apaga PRIMEIRO, registra depois. Na ordem anterior, uma falha no
    // deleteRow deixava no LOG uma exclusão que nunca aconteceu.
    rtiSheet_().deleteRow(achado.linha);
    registrarLog_(sessao.login, sessao.perfil, 'exclusao_rti',
      'excluiu "' + nome + '" (id ' + id + ', cadastrado por ' + cadastradoPor + ')');

    return { ok: true };
  });
}
