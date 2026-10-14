/**
 * MOCI — cadastro por documentos (aba "Documentos" do site).
 *
 * A leitura dos PDFs (memorial + AVCB) é feita pelo n8n, fluxo
 * "MOCI - Leitura de Documentos", com a credencial da OpenAI que fica SÓ no
 * n8n. Nenhuma chave fica neste projeto. O site manda os PDFs direto para o
 * webhook do n8n junto com o token de sessão do MOCI; o n8n chama esta ação
 * para saber se o token é válido e se a pessoa pode cadastrar. Esta ação
 * também conta o limite diário e registra o LOG. Os PDFs não passam por aqui
 * e não ficam guardados em lugar nenhum.
 */

var LEITURA_LIMITE_DIA = 20; // leituras por usuário por dia (protege os créditos da OpenAI)

function handleAutorizarLeituraDocumentos_(body) {
  var sessao = exigirSessao_(body.token, RTI_PERFIS_CADASTRO);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var cota = consumirCotaLeitura_(sessao.login);
  if (cota.erro) return { ok: false, error: cota.erro };

  var arquivos = String(body.arquivos || '').replace(/[^\w.+ ()À-ú-]/g, '').slice(0, 200);
  registrarLog_(sessao.login, sessao.perfil, 'leitura_documentos', 'leitura pedida: ' + (arquivos || '(sem nome)'));
  return { ok: true, login: sessao.login, perfil: sessao.perfil, restantes: cota.restantes };
}

// Conta as leituras do dia por usuário (protege os créditos da OpenAI).
function consumirCotaLeitura_(login) {
  var props = PropertiesService.getScriptProperties();
  var hoje = Utilities.formatDate(new Date(), 'America/Recife', 'yyyyMMdd');
  var chave = 'LEITURAS_' + hoje;
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var mapa = JSON.parse(props.getProperty(chave) || '{}');
    var usadas = mapa[login] || 0;
    if (usadas >= LEITURA_LIMITE_DIA) {
      return { erro: 'Limite de ' + LEITURA_LIMITE_DIA + ' leituras de documentos por dia atingido. Amanhã libera de novo; hoje use a aba "Preencher tudo".' };
    }
    mapa[login] = usadas + 1;
    props.setProperty(chave, JSON.stringify(mapa));
    // limpa contadores de dias anteriores
    Object.keys(props.getProperties()).forEach(function (k) { if (/^LEITURAS_\d{8}$/.test(k) && k !== chave) props.deleteProperty(k); });
    return { restantes: LEITURA_LIMITE_DIA - mapa[login] };
  } finally {
    lock.releaseLock();
  }
}
