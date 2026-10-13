'use strict';

// ===================== Configuração =====================
// A URL do backend e todo o login (sessão, saída por inatividade, área do
// usuário) ficam em auth.js (MociAuth), carregado antes deste arquivo.
// Sem URL configurada, os cadastros ficam só neste navegador (modo teste).
const SHEETS_API_URL = (window.MociAuth && /^https:/.test(MociAuth.API_URL)) ? MociAuth.API_URL : '';

const DEFAULT_CENTER = { lat: -9.3891, lng: -40.5030 }; // Petrolina-PE
const LOCAL_STORAGE_KEY = 'moci_pontos_modo_teste';

const RTI_ALLOWED_PROFILES = ['admin_master', 'admin', 'user1'];
const RTI_EDIT_PROFILES = ['admin_master', 'admin'];
// Vistoriador (user1) e Consulta (user2) podem ver e filtrar a listagem
// de ocupações, mesmo sem poder cadastrar/editar — por isso é uma lista de
// perfis separada de RTI_ALLOWED_PROFILES (cadastro).
const RTI_VIEW_PROFILES = ['admin_master', 'admin', 'user1', 'user2'];

let mapAdapter = null;
let currentCapture = null; // { lat, lng, rua, numero, bairro, cidade }
let locMode = 'gps'; // 'gps' | 'manual' — só relevante para admin_master/admin
let editingId = null; // null = cadastro novo; string = editando essa ocupação
let miniMap = null;
let miniMarker = null;

function getSession() {
  return MociAuth.getSession();
}

function podeCadastrar(session) {
  return !!session && RTI_ALLOWED_PROFILES.indexOf(session.perfil) !== -1;
}

function podeEditar(session) {
  return !!session && RTI_EDIT_PROFILES.indexOf(session.perfil) !== -1;
}

function podeVisualizarLista(session) {
  return !!session && RTI_VIEW_PROFILES.indexOf(session.perfil) !== -1;
}

// Sem sessão, abre a janela de login do próprio MOCI (auth.js) por cima da
// página e, depois de entrar, segue com a ação que a pessoa tinha pedido.
function pedirLogin(aoLogar) {
  MociAuth.pedirLogin(aoLogar);
}

// ===================== Utilitários =====================
function show(el) { el.classList.remove('u-hidden'); }
function hide(el) { el.classList.add('u-hidden'); }

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function fmtCoord(n) {
  return typeof n === 'number' ? n.toFixed(6) : n;
}

function fmtDateBR(isoDate) {
  // Espera 'YYYY-MM-DD'. Monta a data em UTC para não perder um dia por
  // causa do fuso horário local (new Date('YYYY-MM-DD') é interpretado
  // como meia-noite UTC pelo navegador).
  const parts = String(isoDate).split('-');
  if (parts.length !== 3) return isoDate;
  return parts[2] + '/' + parts[1] + '/' + parts[0];
}

function fmtNumberBR(n, decimals) {
  return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function toNullableNumber(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function showGeoWarning() {
  show(document.getElementById('geo-warning'));
}

// Verde: possui AVCB e a validade é hoje ou no futuro. Vermelho: não possui
// AVCB, ou a data informada já passou. Recalculado a cada renderização do
// marcador (não fica salvo pronto), comparando sempre com a data atual.
function getAvcbStatus(point) {
  if (point.possui_avcb !== 'SIM' || !point.data_validade_avcb) {
    return { cor: '#C1121F', valido: false, label: 'Não possui AVCB' };
  }

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const [ano, mes, dia] = String(point.data_validade_avcb).split('-').map(Number);
  const validade = new Date(ano, mes - 1, dia);

  if (isNaN(validade.getTime())) {
    return { cor: '#C1121F', valido: false, label: 'Data de validade do AVCB inválida' };
  }
  if (validade >= hoje) {
    return { cor: '#1E8E4E', valido: true, label: 'Válido até ' + fmtDateBR(point.data_validade_avcb) };
  }
  return { cor: '#C1121F', valido: false, label: 'Vencido desde ' + fmtDateBR(point.data_validade_avcb) };
}

// Endereço estruturado (rua/número/bairro/cidade) tem prioridade — registros
// antigos, cadastrados antes dessa funcionalidade, caem no "endereco" livre
// (reverse geocode do Nominatim) como estava antes.
function enderecoDisplay(point) {
  if (point.rua || point.bairro || point.cidade) {
    const numero = point.numero || 'NI';
    return (point.rua || '—') + ', ' + numero + (point.bairro ? ' - ' + point.bairro : '') + (point.cidade ? ', ' + point.cidade : '');
  }
  return point.endereco || '—';
}

function buildPopupHtml(point, session) {
  const fachadaYes = point.hidrante_fachada === 'SIM';
  const recalqueYes = point.hidrante_recalque === 'SIM';
  const sprinklerYes = point.possui_sprinkler === 'SIM';
  const caldeiraYes = point.possui_caldeira === 'SIM';
  const avcb = getAvcbStatus(point);

  let detalhesHtml = '';
  if (point.quantidade_pavimentos != null && point.quantidade_pavimentos !== '') {
    detalhesHtml += '<div class="row"><span class="label">Pavimentos:</span><span>' + point.quantidade_pavimentos + ' pavimento(s)</span></div>';
  }
  if (point.area_construida != null && point.area_construida !== '') {
    detalhesHtml += '<div class="row"><span class="label">Área construída:</span><span>' + fmtNumberBR(point.area_construida, 2) + ' m²</span></div>';
  }
  if (point.altura_edificacao != null && point.altura_edificacao !== '') {
    detalhesHtml += '<div class="row"><span class="label">Altura:</span><span>' + fmtNumberBR(point.altura_edificacao, 2) + ' m</span></div>';
  }

  const btnEditar = (podeEditar(session) && point.id)
    ? '<button type="button" class="btn-outline-navy btn-popup-editar" data-id="' + escapeHtml(point.id) + '" style="margin-top:10px;width:100%;">✏️ Editar ocupação</button>'
    : '';

  return (
    '<div class="rti-popup">' +
      '<strong>' + escapeHtml(point.nome) + '</strong>' +
      '<div class="row"><span class="label">Endereço:</span><span>' + escapeHtml(enderecoDisplay(point)) + '</span></div>' +
      '<div class="row"><span class="label">Coordenadas:</span><span>' + fmtCoord(point.lat) + ', ' + fmtCoord(point.lng) + '</span></div>' +
      '<div class="row"><span class="label">Capacidade:</span><span>' + escapeHtml(point.capacidade_litros) + ' L</span></div>' +
      detalhesHtml +
      '<div class="chips">' +
        '<span class="chip' + (fachadaYes ? ' yes' : '') + '">Hidrante de fachada: ' + (fachadaYes ? 'SIM' : 'NÃO') + '</span>' +
        '<span class="chip' + (recalqueYes ? ' yes' : '') + '">Hidrante de recalque: ' + (recalqueYes ? 'SIM' : 'NÃO') + '</span>' +
        '<span class="chip' + (sprinklerYes ? ' yes' : '') + '">Sprinklers: ' + (sprinklerYes ? 'SIM' : 'NÃO') + '</span>' +
        '<span class="chip' + (caldeiraYes ? ' yes' : '') + '">Caldeira: ' + (caldeiraYes ? 'SIM' : 'NÃO') + '</span>' +
        '<span class="chip' + (avcb.valido ? ' yes' : '') + '">AVCB: ' + escapeHtml(avcb.label) + '</span>' +
      '</div>' +
      btnEditar +
    '</div>'
  );
}

function normalizePoint(raw) {
  return {
    id: raw.id || '',
    lat: parseFloat(raw.lat),
    lng: parseFloat(raw.lng),
    nome: raw.nome || '',
    capacidade_litros: raw.capacidade_litros || 0,
    hidrante_fachada: raw.hidrante_fachada === 'SIM' ? 'SIM' : 'NAO',
    hidrante_recalque: raw.hidrante_recalque === 'SIM' ? 'SIM' : 'NAO',
    // Pontos cadastrados antes desse campo existir vêm sem "possui_sprinkler"
    // (raw.possui_sprinkler === undefined): tratados como "NAO" até edição
    // manual, já que não há como inferir esse dado do cadastro antigo
    // (substituiu hidrante_publico, sistema diferente).
    possui_sprinkler: raw.possui_sprinkler === 'SIM' ? 'SIM' : 'NAO',
    endereco: raw.endereco || '',
    rua: raw.rua || '',
    numero: raw.numero || '',
    bairro: raw.bairro || '',
    cidade: raw.cidade || '',
    timestamp: raw.timestamp || new Date().toISOString(),
    possui_caldeira: raw.possui_caldeira === 'SIM' ? 'SIM' : 'NAO',
    possui_avcb: raw.possui_avcb === 'SIM' ? 'SIM' : 'NAO',
    data_validade_avcb: raw.data_validade_avcb || null,
    quantidade_pavimentos: toNullableNumber(raw.quantidade_pavimentos),
    area_construida: toNullableNumber(raw.area_construida),
    altura_edificacao: toNullableNumber(raw.altura_edificacao),
    cadastrado_por: raw.cadastrado_por || ''
  };
}

// ===================== Geocodificação reversa =====================
function reverseGeocode(lat, lng, cb) {
  fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng + '&zoom=18&addressdetails=1')
    .then(function (r) { return r.json(); })
    .then(function (data) { cb(parseNominatimAddress(data)); })
    .catch(function () { cb({ rua: '', numero: '', bairro: '', cidade: '' }); });
}

// Nominatim não garante quais chaves vêm preenchidas — tenta as variações
// mais comuns para bairro/cidade dependendo da granularidade do local.
function parseNominatimAddress(data) {
  const a = (data && data.address) || {};
  return {
    rua: a.road || a.pedestrian || a.residential || '',
    numero: a.house_number || '',
    bairro: a.suburb || a.neighbourhood || a.quarter || a.village || '',
    cidade: a.city || a.town || a.municipality || a.county || ''
  };
}

// ===================== Mapa: Leaflet (OpenStreetMap) =====================
function initLeafletMap() {
  const map = L.map('map', { zoomControl: true }).setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  mapAdapter = {
    setCenter: function (lat, lng, zoom) {
      map.setView([lat, lng], zoom || map.getZoom());
    },
    addMarker: function (point) {
      const session = getSession();
      const marker = L.circleMarker([point.lat, point.lng], {
        radius: 9, color: '#ffffff', weight: 2, fillColor: getAvcbStatus(point).cor, fillOpacity: 1
      }).addTo(map);
      marker.bindPopup(buildPopupHtml(point, session));
      marker.on('popupopen', function () {
        const btn = document.querySelector('.btn-popup-editar[data-id="' + point.id + '"]');
        if (btn) btn.addEventListener('click', function () { ativarCarregandoBotaoEditar(btn, point.id); });
      });
      return marker;
    }
  };

  startApp();
}
window.initLeafletMap = initLeafletMap;

// ===================== Fluxo comum da aplicação =====================
function determineInitialLocation(cb) {
  if (!navigator.geolocation) {
    showGeoWarning();
    mapAdapter.setCenter(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng, 13);
    if (cb) cb(null);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    function (pos) {
      const lat = pos.coords.latitude, lng = pos.coords.longitude;
      mapAdapter.setCenter(lat, lng, 15);
      if (cb) cb({ lat: lat, lng: lng });
    },
    function () {
      showGeoWarning();
      mapAdapter.setCenter(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng, 13);
      if (cb) cb(null);
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

function getLocalPoints() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

function setLocalPoints(points) {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(points));
}

function saveLocalPoint(point) {
  const points = getLocalPoints();
  point.id = point.id || (Date.now() + '-' + Math.random().toString(36).slice(2));
  points.push(point);
  setLocalPoints(points);
  return Promise.resolve(point);
}

function updateLocalPoint(id, novosDados) {
  const points = getLocalPoints();
  const idx = points.findIndex(function (p) { return p.id === id; });
  if (idx === -1) return Promise.reject(new Error('Ocupação não encontrada.'));
  points[idx] = Object.assign({}, points[idx], novosDados, { id: id });
  setLocalPoints(points);
  return Promise.resolve(points[idx]);
}

function deleteLocalPoint(id) {
  const points = getLocalPoints();
  const idx = points.findIndex(function (p) { return p.id === id; });
  if (idx === -1) return Promise.reject(new Error('Ocupação não encontrada.'));
  points.splice(idx, 1);
  setLocalPoints(points);
  return Promise.resolve({ ok: true });
}

// ===================== Acesso à API =====================
// O Apps Script responde com uma PÁGINA HTML -- não com JSON -- quando uma
// exceção escapa do doPost, quando a autorização expira ou quando a execução é
// interrompida. Fazer r.json() direto nessa página produz
// "Unexpected token '<', "<!DOCTYPE "... is not valid JSON", que não diz nada
// ao usuário e, pior, esconde o fato de que a operação pode ter sido concluída
// no servidor antes de a resposta se perder. Foi exatamente isso na exclusão do
// OCI CONDOMINIO BUONA VITA: a linha foi apagada, o front quebrou, a lista não
// atualizou e a segunda tentativa acusou "não encontrado".
function lerRespostaJson(r) {
  return r.text().then(function (texto) {
    var dados;
    try {
      dados = JSON.parse(texto);
    } catch (e) {
      if (!r.ok) {
        throw new Error('O servidor respondeu ' + r.status + ' ' + (r.statusText || '') +
          '. A operação pode ter sido concluída — atualize a lista antes de tentar de novo.');
      }
      throw new Error('O servidor não respondeu em JSON (veio uma página HTML). ' +
        'A operação pode ter sido concluída — atualize a lista antes de tentar de novo.');
    }
    if (!r.ok) {
      throw new Error(dados.error || ('Falha na requisição (' + r.status + ').'));
    }
    return dados;
  });
}

// Se o Google desviar o POST para a leitura pública do mapa (doGet), a
// resposta vem com "points" em vez da resposta da ação -- aconteceu uma vez,
// logo após uma reimplantação (13/10/2026). Sem esta checagem, um cadastro
// pareceria salvo sem ter rodado. Mesma checagem em api() (auth.js).
function postApi(payload) {
  return fetch(SHEETS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  }).then(lerRespostaJson).then(function (dados) {
    if (dados && dados.points && payload.action !== 'listarRTIs') {
      throw new Error('O servidor não respondeu como esperado. A operação pode não ter sido concluída — atualize a lista e confira.');
    }
    return dados;
  });
}

let markersById = {};

function loadPoints() {
  markersById = {};
  if (SHEETS_API_URL) {
    fetch(SHEETS_API_URL)
      .then(lerRespostaJson)
      .then(function (data) {
        (data.points || data || []).forEach(function (raw) {
          const p = normalizePoint(raw);
          markersById[p.id] = mapAdapter.addMarker(p);
        });
      })
      .catch(function () { /* mapa continua utilizável mesmo sem pontos */ });
  } else {
    show(document.getElementById('badge-test'));
    getLocalPoints().forEach(function (raw) {
      const p = normalizePoint(raw);
      markersById[p.id] = mapAdapter.addMarker(p);
    });
  }
}

function savePoint(record, token) {
  if (SHEETS_API_URL) {
    const payload = Object.assign({ action: 'cadastrarRTI', token: token }, record);
    return postApi(payload).then(function (res) {
      if (!res.ok) return Promise.reject(new Error(res.error || 'Falha ao salvar.'));
      record.id = res.id;
      return record;
    });
  }
  return saveLocalPoint(record);
}

function editPoint(id, record, token) {
  if (SHEETS_API_URL) {
    const payload = Object.assign({ action: 'editarRTI', token: token, id: id }, record);
    return postApi(payload).then(function (res) {
      if (!res.ok) return Promise.reject(new Error(res.error || 'Falha ao salvar.'));
      return res;
    });
  }
  return updateLocalPoint(id, record);
}

function excluirPoint(id, token) {
  if (SHEETS_API_URL) {
    return postApi({ action: 'excluirRTI', token: token, id: id }).then(function (res) {
      if (!res.ok) return Promise.reject(new Error(res.error || 'Falha ao excluir.'));
      return res;
    });
  }
  return deleteLocalPoint(id);
}

function listarRTIsRemoto(token) {
  if (SHEETS_API_URL) {
    return postApi({ action: 'listarRTIs', token: token });
  }
  return Promise.resolve({ ok: true, points: getLocalPoints() });
}

function startApp() {
  determineInitialLocation();
  loadPoints();

  document.getElementById('btn-locate').addEventListener('click', function () {
    determineInitialLocation(function (loc) { if (loc) mapAdapter.setCenter(loc.lat, loc.lng, 16); });
  });

  wireCadastroModal();
  wireBotaoListar();
  abrirEdicaoViaQueryParam();

  // Entrou, saiu ou a sessão expirou (nesta ou em outra aba): auth.js avisa.
  atualizarVisibilidadeBotaoCadastrar();
  document.addEventListener('moci:sessao', atualizarVisibilidadeBotaoCadastrar);
}

// listar.html manda o admin/admin_master de volta para cá com "?editar=<id>"
// ao clicar em "Editar" na listagem — abre direto o modal de edição desse
// OCI (mesmo fluxo de abrirModalEdicaoPorId, já usado pelo popup do marcador).
//
// abrirModalEdicaoPorId retorna uma Promise que pode rejeitar (sessão sem
// permissão, ponto não encontrado, erro de rede) -- antes, essa rejeição não
// era tratada aqui (ao contrário do botão do popup, que já tinha .catch com
// alert), então qualquer falha ficava muda: a página só terminava de carregar
// normalmente (com o zoom de localização de sempre, sem relação com isso) e
// o usuário via "abriu o mapa" sem nenhum indício de que o pedido de edição
// tinha falhado (achado 13/08/2026, relato do usuário).
function abrirEdicaoViaQueryParam() {
  const id = new URLSearchParams(window.location.search).get('editar');
  if (!id) return;

  function tentar() {
    const session = getSession();
    if (!session) {
      pedirLogin(tentar);
      return;
    }
    if (!podeEditar(session)) {
      window.alert('Sua conta não tem permissão para editar ocupações.');
      return;
    }
    abrirModalEdicaoPorId(id).catch(function (err) {
      window.alert((err && err.message) || 'Não foi possível abrir a edição desta ocupação agora.');
    });
  }
  tentar();
}

// ===================== Modal de cadastro / edição =====================
function wireCadastroModal() {
  const overlay = document.getElementById('modal-overlay');
  const form = document.getElementById('rti-form');
  const formError = document.getElementById('form-error');
  const latEl = document.getElementById('loc-lat');
  const lngEl = document.getElementById('loc-lng');
  const btnSalvar = document.getElementById('btn-salvar');
  const modalTitulo = document.getElementById('modal-titulo');
  const locTabs = document.getElementById('loc-modo-tabs');
  const locGpsBox = document.getElementById('loc-gps-box');
  const locManualBox = document.getElementById('loc-manual-box');
  const inputRua = document.getElementById('input-rua');
  const inputNumero = document.getElementById('input-numero');
  const inputBairro = document.getElementById('input-bairro');
  const inputCidade = document.getElementById('input-cidade');

  function preencherEndereco(addr) {
    inputRua.value = addr.rua || '';
    inputNumero.value = addr.numero || '';
    inputBairro.value = addr.bairro || '';
    inputCidade.value = addr.cidade || '';
  }

  function setCapture(lat, lng) {
    currentCapture = { lat: lat, lng: lng };
    reverseGeocode(lat, lng, function (addr) {
      if (currentCapture && currentCapture.lat === lat && currentCapture.lng === lng) {
        preencherEndereco(addr);
      }
    });
  }

  function captureGps() {
    latEl.textContent = '...';
    lngEl.textContent = '...';
    currentCapture = null;

    if (!navigator.geolocation) {
      latEl.textContent = 'Indisponível';
      lngEl.textContent = 'Indisponível';
      return;
    }

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        const lat = pos.coords.latitude, lng = pos.coords.longitude;
        latEl.textContent = fmtCoord(lat);
        lngEl.textContent = fmtCoord(lng);
        setCapture(lat, lng);
      },
      function () {
        latEl.textContent = 'Indisponível';
        lngEl.textContent = 'Indisponível';
        formError.textContent = 'Permita o acesso à localização e tente novamente, ou toque em "Atualizar localização".';
        show(formError);
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  function initMiniMap(lat, lng) {
    const latManualEl = document.getElementById('loc-lat-manual');
    const lngManualEl = document.getElementById('loc-lng-manual');

    if (!miniMap) {
      miniMap = L.map('mini-map', { zoomControl: true }).setView([lat, lng], 16);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(miniMap);
      miniMap.on('click', function (e) {
        placeMiniMarker(e.latlng.lat, e.latlng.lng);
      });
    } else {
      miniMap.setView([lat, lng], 16);
    }
    setTimeout(function () { miniMap.invalidateSize(); }, 50);

    function placeMiniMarker(lat, lng) {
      if (miniMarker) {
        miniMarker.setLatLng([lat, lng]);
      } else {
        miniMarker = L.marker([lat, lng], { draggable: true }).addTo(miniMap);
        miniMarker.on('dragend', function () {
          const pos = miniMarker.getLatLng();
          latManualEl.textContent = fmtCoord(pos.lat);
          lngManualEl.textContent = fmtCoord(pos.lng);
          setCapture(pos.lat, pos.lng);
        });
      }
      latManualEl.textContent = fmtCoord(lat);
      lngManualEl.textContent = fmtCoord(lng);
      setCapture(lat, lng);
    }

    if (miniMarker) miniMap.removeLayer(miniMarker);
    miniMarker = null;
    placeMiniMarker(lat, lng);
  }

  function trocarModoLocalizacao(modo) {
    locMode = modo;
    document.querySelectorAll('.loc-tab').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.modo === modo);
    });
    if (modo === 'gps') {
      hide(locManualBox);
      show(locGpsBox);
      captureGps();
    } else {
      hide(locGpsBox);
      show(locManualBox);
      const centro = currentCapture || DEFAULT_CENTER;
      initMiniMap(centro.lat, centro.lng);
    }
  }
  document.querySelectorAll('.loc-tab').forEach(function (btn) {
    btn.addEventListener('click', function () { trocarModoLocalizacao(btn.dataset.modo); });
  });

  const checkAvcb = document.getElementById('check-avcb');
  const campoDataAvcb = document.getElementById('campo-data-avcb');
  const inputDataAvcb = document.getElementById('input-data-avcb');

  function toggleCampoDataAvcb() {
    if (checkAvcb.checked) {
      show(campoDataAvcb);
    } else {
      hide(campoDataAvcb);
      inputDataAvcb.value = '';
    }
  }
  checkAvcb.addEventListener('change', toggleCampoDataAvcb);

  function preencherFormParaEdicao(point) {
    document.getElementById('input-nome').value = point.nome || '';
    document.getElementById('input-capacidade').value = point.capacidade_litros || '';
    document.getElementById('check-fachada').checked = point.hidrante_fachada === 'SIM';
    document.getElementById('check-recalque').checked = point.hidrante_recalque === 'SIM';
    document.getElementById('check-sprinkler').checked = point.possui_sprinkler === 'SIM';
    document.getElementById('check-caldeira').checked = point.possui_caldeira === 'SIM';
    checkAvcb.checked = point.possui_avcb === 'SIM';
    toggleCampoDataAvcb();
    inputDataAvcb.value = point.data_validade_avcb || '';
    document.getElementById('input-pavimentos').value = point.quantidade_pavimentos != null ? point.quantidade_pavimentos : '';
    document.getElementById('input-area').value = point.area_construida != null ? point.area_construida : '';
    document.getElementById('input-altura').value = point.altura_edificacao != null ? point.altura_edificacao : '';
    preencherEndereco({ rua: point.rua, numero: point.numero, bairro: point.bairro, cidade: point.cidade });
    currentCapture = { lat: point.lat, lng: point.lng };
  }

  function openModal(pointToEdit) {
    const session = getSession();
    if (!session) {
      pedirLogin(function () { openModal(pointToEdit); });
      return;
    }
    if (RTI_ALLOWED_PROFILES.indexOf(session.perfil) === -1) {
      window.alert('Sua conta não tem permissão para cadastrar ocupações.');
      return;
    }
    if (pointToEdit && !podeEditar(session)) {
      window.alert('Sua conta não tem permissão para editar ocupações.');
      return;
    }

    form.reset();
    hide(formError);
    hide(campoDataAvcb); // form.reset() não dispara 'change', então esconde manualmente

    editingId = pointToEdit ? pointToEdit.id : null;
    modalTitulo.textContent = editingId ? 'Editar ocupação' : 'Cadastrar ocupação';
    btnSalvar.textContent = editingId ? 'Salvar edição' : 'Salvar cadastro';

    show(overlay);

    const mostraTabs = podeEditar(session); // admin_master/admin podem escolher GPS ou manual
    if (mostraTabs) {
      show(locTabs);
    } else {
      hide(locTabs);
    }

    if (editingId) {
      preencherFormParaEdicao(pointToEdit);
      trocarModoLocalizacao('manual');
      // trocarModoLocalizacao('manual') reseta o campo de endereço via
      // reverseGeocode assíncrono; reaplica os valores originais depois.
      setTimeout(function () { preencherEndereco({ rua: pointToEdit.rua, numero: pointToEdit.numero, bairro: pointToEdit.bairro, cidade: pointToEdit.cidade }); }, 300);
    } else if (mostraTabs) {
      trocarModoLocalizacao('gps');
    } else {
      hide(locTabs);
      show(locGpsBox);
      hide(locManualBox);
      captureGps();
    }
  }

  function closeModal() {
    hide(overlay);
    editingId = null;
  }

  // Se o card já tem algo digitado, fechar (X ou toque no fundo escuro fora
  // do card) pede confirmação antes de descartar — evita perder o
  // preenchimento por um toque acidental (ex.: teclado do celular abrindo/
  // fechando e deslocando a tela enquanto o usuário ainda está digitando).
  function formTemDadosPreenchidos() {
    return !!(
      document.getElementById('input-nome').value.trim() ||
      document.getElementById('input-capacidade').value ||
      inputRua.value.trim() || inputNumero.value.trim() || inputBairro.value.trim() || inputCidade.value.trim() ||
      document.getElementById('input-pavimentos').value ||
      document.getElementById('input-area').value ||
      document.getElementById('input-altura').value ||
      document.getElementById('check-fachada').checked ||
      document.getElementById('check-recalque').checked ||
      document.getElementById('check-sprinkler').checked ||
      document.getElementById('check-caldeira').checked ||
      checkAvcb.checked
    );
  }

  function fecharComConfirmacao() {
    if (formTemDadosPreenchidos() && !window.confirm('Fechar sem salvar? Os dados preenchidos neste cadastro serão perdidos.')) {
      return;
    }
    closeModal();
  }

  document.getElementById('btn-cadastrar').addEventListener('click', function () { openModal(null); });
  document.getElementById('modal-close').addEventListener('click', fecharComConfirmacao);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) fecharComConfirmacao(); });
  document.getElementById('btn-atualizar-loc').addEventListener('click', captureGps);

  window.abrirModalEdicaoComPonto = openModal;

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    hide(formError);

    const nome = document.getElementById('input-nome').value.trim();
    const capacidade = document.getElementById('input-capacidade').value;

    const session = getSession();
    if (!session || RTI_ALLOWED_PROFILES.indexOf(session.perfil) === -1) {
      // Sessão expirou com o formulário aberto: entra de novo por cima dele,
      // sem perder o que foi preenchido, e depois é só clicar em salvar.
      formError.textContent = 'Sua sessão expirou. Entre novamente e clique em salvar.';
      show(formError);
      pedirLogin(function () { hide(formError); });
      return;
    }
    if (!currentCapture || typeof currentCapture.lat !== 'number') {
      formError.textContent = locMode === 'manual'
        ? 'Toque no mapa para marcar a localização da ocupação.'
        : 'Não foi possível obter sua localização. Toque em "Atualizar localização" e tente novamente.';
      show(formError);
      return;
    }
    if (!nome) {
      formError.textContent = 'Informe o nome do edifício ou empresa.';
      show(formError);
      return;
    }
    if (!capacidade || Number(capacidade) < 0) {
      formError.textContent = 'Informe a capacidade da RTI em litros (0 é aceito, para imóveis sem reserva).';
      show(formError);
      return;
    }

    const rua = inputRua.value.trim();
    const numero = inputNumero.value.trim();
    const bairro = inputBairro.value.trim();
    const cidade = inputCidade.value.trim();
    if (!rua || !numero || !bairro || !cidade) {
      formError.textContent = 'Informe rua, número (ou "NI" se não houver), bairro e cidade.';
      show(formError);
      return;
    }

    const possuiAvcb = checkAvcb.checked;
    const dataValidadeAvcb = inputDataAvcb.value;
    if (possuiAvcb && !dataValidadeAvcb) {
      formError.textContent = 'Informe a data de validade do AVCB, ou desmarque "Possui AVCB válido".';
      show(formError);
      return;
    }

    const pavimentos = document.getElementById('input-pavimentos').value;
    if (pavimentos && Number(pavimentos) < 1) {
      formError.textContent = 'A quantidade de pavimentos deve ser 1 ou mais.';
      show(formError);
      return;
    }
    const area = document.getElementById('input-area').value;
    if (area && Number(area) < 0) {
      formError.textContent = 'A área construída não pode ser negativa.';
      show(formError);
      return;
    }
    const altura = document.getElementById('input-altura').value;
    if (altura && Number(altura) < 0) {
      formError.textContent = 'A altura da edificação não pode ser negativa.';
      show(formError);
      return;
    }

    const record = {
      timestamp: new Date().toISOString(),
      lat: currentCapture.lat,
      lng: currentCapture.lng,
      nome: nome,
      capacidade_litros: Number(capacidade),
      hidrante_fachada: document.getElementById('check-fachada').checked ? 'SIM' : 'NAO',
      hidrante_recalque: document.getElementById('check-recalque').checked ? 'SIM' : 'NAO',
      possui_sprinkler: document.getElementById('check-sprinkler').checked ? 'SIM' : 'NAO',
      possui_caldeira: document.getElementById('check-caldeira').checked ? 'SIM' : 'NAO',
      rua: rua,
      numero: numero,
      bairro: bairro,
      cidade: cidade,
      endereco: rua + ', ' + numero + ' - ' + bairro + ', ' + cidade,
      possui_avcb: possuiAvcb ? 'SIM' : 'NAO',
      data_validade_avcb: possuiAvcb ? dataValidadeAvcb : '',
      quantidade_pavimentos: pavimentos ? Number(pavimentos) : '',
      area_construida: area ? Number(area) : '',
      altura_edificacao: altura ? Number(altura) : '',
      // Ignorado pelo backend real (Code.gs sempre usa o login da sessão
      // validada no servidor, nunca o que o cliente manda) — só é levado em
      // conta no modo teste (SHEETS_API_URL vazia, sem servidor nenhum).
      cadastrado_por: session.login
    };

    btnSalvar.disabled = true;
    btnSalvar.textContent = editingId ? 'Salvando edição...' : 'Salvando...';

    const acao = editingId
      ? editPoint(editingId, record, session.token)
      : savePoint(record, session.token);

    acao
      .then(function (res) {
        const pontoFinal = normalizePoint(Object.assign({}, record, { id: editingId || (res && res.id) }));
        if (editingId && markersById[editingId]) {
          markersById[editingId].remove();
        }
        markersById[pontoFinal.id] = mapAdapter.addMarker(pontoFinal);
        closeModal();
      })
      .catch(function (err) {
        formError.textContent = (err && err.message) || 'Não foi possível salvar agora. Verifique sua conexão e tente novamente.';
        show(formError);
      })
      .finally(function () {
        btnSalvar.disabled = false;
        btnSalvar.textContent = editingId ? 'Salvar edição' : 'Salvar cadastro';
      });
  });
}

function abrirModalEdicaoPorId(id) {
  const session = getSession();
  if (!podeEditar(session)) return Promise.resolve();
  return listarRTIsRemoto(session.token).then(function (res) {
    if (!res.ok) throw new Error(res.error || 'Não foi possível carregar os dados agora.');
    const ponto = (res.points || []).map(normalizePoint).find(function (p) { return p.id === id; });
    if (!ponto) throw new Error('Ocupação não encontrada — pode ter sido removida.');
    if (window.abrirModalEdicaoComPonto) window.abrirModalEdicaoComPonto(ponto);
  });
}
function abrirModalEdicao(id) { return abrirModalEdicaoPorId(id); }

// Mostra "Carregando..." no botão de edição do popup do mapa enquanto busca
// os dados atualizados do ponto -- sem isso, o clique parecia travado, ja
// que abrirModalEdicaoPorId busca a lista inteira de OCIs antes de abrir o
// modal (usuario relatou "demorou a abrir o campo de editar" sem nenhum
// sinal na tela de que algo estava acontecendo).
function ativarCarregandoBotaoEditar(btn, id) {
  const textoOriginal = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Carregando...';
  abrirModalEdicao(id).catch(function (err) {
    window.alert((err && err.message) || 'Não foi possível abrir a edição agora.');
  }).finally(function () {
    btn.disabled = false;
    btn.textContent = textoOriginal;
  });
}

// ===================== Botão "Listar OCI" (abre listar.html numa aba própria) =====================
// A listagem com filtro/distância vive em listar.html, página separada — ela
// lê a mesma sessão do localStorage (mesmo site), então não precisa repassar
// token nenhum pela URL. Aqui só garante que o usuário já entrou antes de
// abrir a aba, pra ela já carregar com sessão pronta.
// Nome de aba fixo (em vez de "_blank"): cliques repetidos reaproveitam a
// mesma aba (só troca de foco) em vez de abrir uma nova a cada clique.
var LISTAR_OCI_TAB_NAME = 'moci-listar-tab';
function wireBotaoListar() {
  document.getElementById('btn-listar').addEventListener('click', function () {
    const session = getSession();
    if (!session) {
      pedirLogin(function () { window.open('listar.html', LISTAR_OCI_TAB_NAME); });
      return;
    }
    if (!podeVisualizarLista(session)) {
      window.alert('Sua conta não tem acesso à lista de ocupações.');
      return;
    }
    window.open('listar.html', LISTAR_OCI_TAB_NAME);
  });
}

// "+ Cadastrar ocupação" só aparece para quem pode cadastrar (admin_master,
// admin, user1) — Consulta (user2) e visitantes sem sessão nunca veem o botão.
// Reavaliado a cada entrada/saída (evento "moci:sessao", ver auth.js), para o
// botão aparecer ou sumir sem precisar recarregar a página.
function atualizarVisibilidadeBotaoCadastrar() {
  const btn = document.getElementById('btn-cadastrar');
  if (podeCadastrar(getSession())) show(btn); else hide(btn);
}
