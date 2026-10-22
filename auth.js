'use strict';
// =====================================================================
// MOCI — autenticação do próprio site: login, sessão, saída por
// inatividade e a área do usuário no topo das páginas.
// Usado por index.html, listar.html, usuarios.html, conta.html e log.html.
// Senha e perfil são sempre conferidos no servidor (Apps Script); aqui fica
// só o token de sessão, que expira sozinho em 8 h.
// =====================================================================
(function (global) {
  // URL /exec do backend (Apps Script "MOCI - Base de dados").
  var API_URL = 'https://script.google.com/macros/s/AKfycbyvQ84nrli6GUanIhbqNl92C-GiCws214Q0xU2CnfBAmo0OsVVFtcWmPtf7XyZcRR9S6A/exec';

  var CHAVE_SESSAO = 'moci_session';
  var CHAVE_ATIVIDADE = 'moci_last_activity';
  var INATIVIDADE_LIMITE_MS = 30 * 60 * 1000;   // 30 min sem uso -> sai
  var INATIVIDADE_CHECK_MS = 30 * 1000;
  var INATIVIDADE_THROTTLE_MS = 5 * 1000;

  var NOME_PERFIL = {
    admin_master: 'Administrador geral',
    admin: 'Administrador',
    user1: 'Vistoriador',
    user2: 'Consulta'
  };

  // ---------------- sessão ----------------
  function getSession() {
    try {
      var s = JSON.parse(localStorage.getItem(CHAVE_SESSAO) || 'null');
      return (s && s.token && s.perfil) ? s : null;
    } catch (e) { return null; }
  }
  function setSession(s) {
    try { localStorage.setItem(CHAVE_SESSAO, JSON.stringify(s)); } catch (e) { /* sem armazenamento */ }
    registrarAtividade(true);
    avisarMudanca();
  }
  function limparSessao() {
    try { localStorage.removeItem(CHAVE_SESSAO); } catch (e) { /* idem */ }
    avisarMudanca();
  }
  function avisarMudanca() {
    document.dispatchEvent(new CustomEvent('moci:sessao', { detail: getSession() }));
  }
  function temPerfil(perfis) {
    var s = getSession();
    return !!s && perfis.indexOf(s.perfil) !== -1;
  }

  // ---------------- chamada ao backend ----------------
  // Lê como texto antes de converter: se o Apps Script devolver a página de
  // erro em HTML, a mensagem fica clara em vez de "Unexpected token '<'".
  function api(payload) {
    return fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.text().then(function (texto) {
        var dados;
        try { dados = JSON.parse(texto); } catch (e) {
          throw new Error('O servidor não respondeu como esperado. A operação pode ter sido concluída — atualize a página antes de tentar de novo.');
        }
        if (!r.ok) throw new Error(dados.error || ('Falha na requisição (' + r.status + ').'));
        // POST desviado para a leitura pública (doGet): ver postApi em app.js.
        if (dados && dados.points && payload.action !== 'listarRTIs') {
          throw new Error('O servidor não respondeu como esperado. A operação pode não ter sido concluída — atualize a página e confira.');
        }
        return dados;
      });
    });
  }

  function entrar(login, senha) {
    return api({ action: 'login', login: login, senha: senha }).then(function (res) {
      if (!res.ok) throw new Error(res.error || 'Não foi possível entrar.');
      setSession({ token: res.token, login: res.login, perfil: res.perfil });
      return getSession();
    });
  }

  function sair() {
    var s = getSession();
    if (s) api({ action: 'logout', token: s.token }).catch(function () { /* sai mesmo sem rede */ });
    limparSessao();
  }

  // Ao abrir a página, confere no servidor se a sessão guardada ainda vale.
  function conferirSessaoNoServidor() {
    var s = getSession();
    if (!s) return;
    api({ action: 'validarToken', token: s.token }).then(function (res) {
      if (!res.ok) limparSessao();
    }).catch(function () { /* sem rede: mantém até o próximo uso */ });
  }

  // ---------------- saída por inatividade ----------------
  function registrarAtividade(forcar) {
    var agora = Date.now();
    var ultimo = Number(localStorage.getItem(CHAVE_ATIVIDADE) || 0);
    if (forcar === true || agora - ultimo > INATIVIDADE_THROTTLE_MS) {
      try { localStorage.setItem(CHAVE_ATIVIDADE, String(agora)); } catch (e) { /* idem */ }
    }
  }
  function iniciarMonitorInatividade() {
    registrarAtividade();
    ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'].forEach(function (evt) {
      document.addEventListener(evt, registrarAtividade, { passive: true });
    });
    setInterval(function () {
      if (!getSession()) return;
      var ultimo = Number(localStorage.getItem(CHAVE_ATIVIDADE) || 0);
      if (Date.now() - ultimo > INATIVIDADE_LIMITE_MS) sair();
    }, INATIVIDADE_CHECK_MS);
    // Login/logout feito em outra aba do MOCI vale para esta também.
    window.addEventListener('storage', function (e) { if (e.key === CHAVE_SESSAO) avisarMudanca(); });
  }

  // ---------------- tela de login (janela sobre a página) ----------------
  var modal = null, aoLogarPendente = null;

  function montarModal() {
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'login-overlay u-hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'login-titulo');
    modal.innerHTML =
      '<div class="login-card">' +
        '<div class="login-head">' +
          '<button type="button" class="login-fechar" aria-label="Fechar">&times;</button>' +
          '<div class="login-logo"><img src="CAT-SERTAO-SEM-FUNDO.png" alt="Brasão do CAT Sertão"></div>' +
          '<div class="login-org">CAT Sertão · CBMPE</div>' +
          '<div class="login-titulo" id="login-titulo">MOCI</div>' +
          '<div class="login-sub">Mapa de Ocupações Contra Incêndio</div>' +
        '</div>' +
        '<form class="login-form" autocomplete="on" novalidate>' +
          '<p class="login-hint">Acesso restrito ao efetivo cadastrado.<br>Informe suas credenciais para continuar.</p>' +
          '<label class="field">Usuário<input name="login" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next" placeholder="Digite o usuário"></label>' +
          '<label class="field">Senha<input name="senha" type="password" autocomplete="current-password" enterkeyhint="go" placeholder="Digite a senha"></label>' +
          '<p class="field-error u-hidden" role="alert"></p>' +
          '<button type="submit" class="btn-red login-entrar"><span class="login-spinner u-hidden" aria-hidden="true"></span><span class="login-rotulo">Entrar</span></button>' +
          '<p class="login-rodape">A consulta ao mapa e à lista de ocupações é pública. O login é necessário para cadastrar e editar ocupações.</p>' +
        '</form>' +
      '</div>';
    document.body.appendChild(modal);

    var form = modal.querySelector('form');
    var erro = modal.querySelector('.field-error');
    var btn = modal.querySelector('.login-entrar');
    var spinner = modal.querySelector('.login-spinner');
    var rotulo = modal.querySelector('.login-rotulo');

    function fechar() { modal.classList.add('u-hidden'); aoLogarPendente = null; }
    modal.querySelector('.login-fechar').addEventListener('click', fechar);
    modal.addEventListener('click', function (e) { if (e.target === modal) fechar(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !modal.classList.contains('u-hidden')) fechar(); });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var login = form.login.value.trim(), senha = form.senha.value;
      erro.classList.add('u-hidden');
      if (!login || !senha) { erro.textContent = 'Informe usuário e senha.'; erro.classList.remove('u-hidden'); return; }
      btn.disabled = true; spinner.classList.remove('u-hidden'); rotulo.textContent = 'Entrando...';
      entrar(login, senha).then(function (s) {
        form.senha.value = '';
        var cb = aoLogarPendente;
        modal.classList.add('u-hidden');
        aoLogarPendente = null;
        if (cb) cb(s);
      }).catch(function (err) {
        erro.textContent = (err && err.message) || 'Não foi possível entrar agora.';
        erro.classList.remove('u-hidden');
      }).then(function () {
        btn.disabled = false; spinner.classList.add('u-hidden'); rotulo.textContent = 'Entrar';
      });
    });
    return modal;
  }

  // Pede login (se ainda não houver sessão) e depois segue com a ação.
  function pedirLogin(aoLogar) {
    var s = getSession();
    if (s) { if (aoLogar) aoLogar(s); return; }
    montarModal();
    aoLogarPendente = aoLogar || null;
    modal.classList.remove('u-hidden');
    setTimeout(function () { modal.querySelector('input[name=login]').focus(); }, 30);
  }

  // ---------------- área do usuário no topo ----------------
  function escapar(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function renderAreaUsuario() {
    var area = document.getElementById('area-usuario');
    if (!area) return;
    var s = getSession();
    if (!s) {
      area.innerHTML = '<button type="button" class="btn-topo" id="btn-entrar">Entrar</button>';
      document.getElementById('btn-entrar').addEventListener('click', function () { pedirLogin(); });
      return;
    }
    var links = '<a href="index.html">Mapa</a>';
    if (['admin_master', 'admin', 'user1', 'user2'].indexOf(s.perfil) !== -1) links += '<a href="listar.html">Lista de ocupações</a>';
    if (['admin_master', 'admin'].indexOf(s.perfil) !== -1) links += '<a href="usuarios.html">Usuários</a>';
    if (s.perfil === 'admin_master') links += '<a href="log.html">LOG de auditoria</a>';
    links += '<a href="conta.html">Minha conta</a>';
    area.innerHTML =
      '<details class="menu-usuario">' +
        '<summary><span class="dot" aria-hidden="true"></span>' + escapar(s.login) + ' · ' + escapar(NOME_PERFIL[s.perfil] || s.perfil) + '</summary>' +
        '<nav class="menu-usuario-lista">' + links + '<button type="button" id="btn-sair">Sair</button></nav>' +
      '</details>';
    document.getElementById('btn-sair').addEventListener('click', function () {
      sair();
      // Páginas que só existem com login voltam para o mapa.
      if (document.body.hasAttribute('data-exige-login')) window.location.href = 'index.html';
    });
  }

  // Para páginas que só fazem sentido logado (usuarios/conta/log):
  // pede login se preciso, confere o perfil e só então chama "liberar".
  function exigirPagina(perfis, liberar, negar) {
    function tentar() {
      var s = getSession();
      if (!s) { pedirLogin(tentar); return; }
      if (perfis && perfis.indexOf(s.perfil) === -1) { if (negar) negar(s); return; }
      liberar(s);
    }
    tentar();
  }

  document.addEventListener('moci:sessao', renderAreaUsuario);
  document.addEventListener('DOMContentLoaded', function () {
    renderAreaUsuario();
    conferirSessaoNoServidor();
  });
  iniciarMonitorInatividade();

  global.MociAuth = {
    API_URL: API_URL,
    NOME_PERFIL: NOME_PERFIL,
    getSession: getSession,
    setSession: setSession,
    temPerfil: temPerfil,
    api: api,
    pedirLogin: pedirLogin,
    sair: sair,
    exigirPagina: exigirPagina,
    escapar: escapar
  };
})(window);
