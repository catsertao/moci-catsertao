'use strict';

// ===================== Configuração =====================
// A URL do backend e todo o login (sessão, saída por inatividade, área do
// usuário) ficam em auth.js (MociAuth), carregado antes deste arquivo.
// Sem URL configurada, os cadastros ficam só neste navegador (modo teste).
const SHEETS_API_URL = (window.MociAuth && /^https:/.test(MociAuth.API_URL)) ? MociAuth.API_URL : '';

const DEFAULT_CENTER = { lat: -9.3891, lng: -40.5030 }; // Petrolina-PE
const LOCAL_STORAGE_KEY = 'moci_pontos_modo_teste';
// Leitura do memorial/AVCB por IA: fluxo "MOCI - Leitura de Documentos" no n8n
// (a chave da OpenAI fica só lá; o n8n confere o token no MOCI antes de ler).
const LEITURA_DOCS_URL = 'https://sternplatypus-n8n.cloudfy.live/webhook/moci-leitura-documentos';

const RTI_ALLOWED_PROFILES = ['admin_master', 'admin', 'user1'];
const RTI_EDIT_PROFILES = ['admin_master', 'admin'];
// Vistoriador (user1) e Consulta (user2) podem ver e filtrar a listagem
// de ocupações, mesmo sem poder cadastrar/editar — por isso é uma lista de
// perfis separada de RTI_ALLOWED_PROFILES (cadastro).
const RTI_VIEW_PROFILES = ['admin_master', 'admin', 'user1', 'user2'];

let mapAdapter = null;
let currentCapture = null; // { lat, lng, rua, numero, bairro, cidade }
let locMode = 'documentos'; // aba do cadastro: 'documentos' | 'gps' | 'mapa' (a edição usa 'mapa')
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
let pontosPorId = {}; // pontos já no mapa — usado para avisar de cadastro duplicado (aba Documentos)

function loadPoints() {
  markersById = {};
  pontosPorId = {};
  if (SHEETS_API_URL) {
    fetch(SHEETS_API_URL)
      .then(lerRespostaJson)
      .then(function (data) {
        (data.points || data || []).forEach(function (raw) {
          const p = normalizePoint(raw);
          markersById[p.id] = mapAdapter.addMarker(p);
          pontosPorId[p.id] = p;
        });
      })
      .catch(function () { /* mapa continua utilizável mesmo sem pontos */ });
  } else {
    show(document.getElementById('badge-test'));
    getLocalPoints().forEach(function (raw) {
      const p = normalizePoint(raw);
      markersById[p.id] = mapAdapter.addMarker(p);
      pontosPorId[p.id] = p;
    });
  }
}

// Distância em metros entre duas coordenadas (fórmula de haversine).
function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Ocupação já cadastrada mais próxima, se estiver a menos de `raio` metros.
function pontoProximo(lat, lng, raio) {
  let melhor = null;
  Object.keys(pontosPorId).forEach(function (id) {
    const p = pontosPorId[id];
    const d = distanciaMetros(lat, lng, p.lat, p.lng);
    if (d <= raio && (!melhor || d < melhor.distancia)) melhor = { ponto: p, distancia: d };
  });
  return melhor;
}

// Lê um arquivo do <input type="file"> e devolve só o base64 (sem o "data:...;base64,").
function lerArquivoBase64(arquivo) {
  return new Promise(function (resolve, reject) {
    const fr = new FileReader();
    fr.onload = function () { resolve(String(fr.result).replace(/^data:[^,]*,/, '')); };
    fr.onerror = function () { reject(new Error('Não foi possível ler o arquivo "' + arquivo.name + '".')); };
    fr.readAsDataURL(arquivo);
  });
}

// Coordenada digitada em graus decimais com 6 casas. Aceita vírgula decimal
// ("-9,389123"); sem sinal, aplica o negativo (Pernambuco fica ao sul e a oeste).
function lerCoordenada(texto, ehLatitude) {
  let s = String(texto || '').trim().replace(/\s+/g, '');
  if (!s) return { vazio: true };
  if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  const m = /^(-?)(\d{1,3})\.(\d+)$/.exec(s);
  if (!m) return { erro: (ehLatitude ? 'Latitude' : 'Longitude') + ' em graus decimais, ex.: ' + (ehLatitude ? '-9.389123' : '-40.503456') + '.' };
  if (m[3].length < 6) return { erro: (ehLatitude ? 'Latitude' : 'Longitude') + ': digite 6 casas decimais (faltam ' + (6 - m[3].length) + ').' };
  let v = Math.round(Number(m[2] + '.' + m[3]) * 1e6) / 1e6;
  const ajustado = !m[1];
  v = -v;
  if (ehLatitude ? Math.abs(v) > 90 : Math.abs(v) > 180) return { erro: (ehLatitude ? 'Latitude' : 'Longitude') + ' fora do intervalo válido.' };
  return { valor: v, ajustado: ajustado };
}

// Pernambuco continental + Fernando de Noronha (com folga).
function dentroDePernambuco(lat, lng) {
  const continente = lat >= -9.6 && lat <= -7.1 && lng >= -41.5 && lng <= -34.7;
  const noronha = lat >= -4.0 && lat <= -3.7 && lng >= -32.6 && lng <= -32.3;
  return continente || noronha;
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

  // ===================== Abas do cadastro: documentos | gps | mapa =====================
  const cadAbas = document.getElementById('cad-abas');
  const painelDocs = document.getElementById('painel-documentos');
  const locDocBox = document.getElementById('loc-doc-box');
  const avisosBox = document.getElementById('leitura-avisos');
  const docMemorial = document.getElementById('doc-memorial');
  const docAvcb = document.getElementById('doc-avcb');
  const docLat = document.getElementById('doc-lat');
  const docLng = document.getElementById('doc-lng');
  const docMsg = document.getElementById('doc-coord-msg');
  const docErro = document.getElementById('doc-erro');
  const btnLerDocs = document.getElementById('btn-ler-docs');
  const btnCamadaDoc = document.getElementById('btn-camada-doc');
  let leituraFeita = false;   // aba Documentos: true = formulário preenchido pela leitura, em conferência
  let coordDoc = null;        // { lat, lng } digitadas e válidas
  let mapaDoc = null, marcadorDoc = null, camadaRuaDoc = null, camadaSatDoc = null, sateliteDoc = false;

  function rolarModalParaTopo() {
    const card = overlay.querySelector('.modal-card');
    if (card) card.scrollTop = 0;
  }

  function mostrarAvisos(lista) {
    avisosBox.innerHTML = '';
    if (!lista || !lista.length) { hide(avisosBox); return; }
    const titulo = document.createElement('strong');
    titulo.textContent = lista[0];
    avisosBox.appendChild(titulo);
    if (lista.length > 1) {
      const ul = document.createElement('ul');
      lista.slice(1).forEach(function (t) { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
      avisosBox.appendChild(ul);
    }
    show(avisosBox);
  }

  function selecionarAba(aba) {
    locMode = aba;
    document.querySelectorAll('.cad-aba').forEach(function (b) {
      const ativa = b.dataset.aba === aba;
      b.classList.toggle('active', ativa);
      b.setAttribute('aria-selected', ativa ? 'true' : 'false');
    });
    hide(formError);
    if (aba === 'documentos') {
      hide(locGpsBox);
      hide(locManualBox);
      if (leituraFeita) {
        hide(painelDocs); show(form); show(locDocBox);
      } else {
        show(painelDocs); hide(form); hide(locDocBox);
        iniciarMapaDoc();
      }
      rolarModalParaTopo();
      return;
    }
    hide(painelDocs);
    hide(locDocBox);
    mostrarAvisos([]);
    show(form);
    if (aba === 'gps') {
      hide(locManualBox);
      show(locGpsBox);
      captureGps();
    } else {
      hide(locGpsBox);
      show(locManualBox);
      const centro = currentCapture || DEFAULT_CENTER;
      initMiniMap(centro.lat, centro.lng);
    }
    rolarModalParaTopo();
  }

  // Volta tudo ao estado de "cadastro novo" (arquivos, coordenadas e formulário).
  function limparCadastro() {
    form.reset();
    hide(campoDataAvcb);
    leituraFeita = false;
    currentCapture = null;
    coordDoc = null;
    docMemorial.value = '';
    docAvcb.value = '';
    docLat.value = '';
    docLng.value = '';
    hide(docMsg);
    hide(docErro);
    mostrarAvisos([]);
    if (marcadorDoc && mapaDoc) { mapaDoc.removeLayer(marcadorDoc); marcadorDoc = null; }
  }

  document.querySelectorAll('.cad-aba').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.dataset.aba === locMode) return;
      if ((formTemDadosPreenchidos() || leituraFeita) &&
          !window.confirm('Trocar de aba descarta o que já foi preenchido neste cadastro. Continuar?')) return;
      limparCadastro();
      selecionarAba(btn.dataset.aba);
    });
  });

  // ----- Mini-mapa da aba Documentos (com camada de satélite) -----
  function iniciarMapaDoc() {
    if (!mapaDoc) {
      mapaDoc = L.map('mini-map-doc', { zoomControl: true }).setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], 12);
      camadaRuaDoc = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
      }).addTo(mapaDoc);
      camadaSatDoc = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        // no sertão as imagens vão só até o zoom 17; acima disso amplia o 17
        maxZoom: 19, maxNativeZoom: 17, attribution: 'Imagens &copy; Esri, Maxar, Earthstar Geographics'
      });
    }
    setTimeout(function () { mapaDoc.invalidateSize(); }, 50);
  }

  btnCamadaDoc.addEventListener('click', function () {
    if (!mapaDoc) return;
    sateliteDoc = !sateliteDoc;
    if (sateliteDoc) { mapaDoc.removeLayer(camadaRuaDoc); camadaSatDoc.addTo(mapaDoc); }
    else { mapaDoc.removeLayer(camadaSatDoc); camadaRuaDoc.addTo(mapaDoc); }
    btnCamadaDoc.textContent = sateliteDoc ? '🗺️ Mapa' : '🛰️ Satélite';
  });

  function mensagemCoord(tipo, textos, acao) {
    docMsg.innerHTML = '';
    docMsg.className = 'coord-msg ' + tipo;
    textos.forEach(function (t) { const p = document.createElement('div'); p.textContent = t; docMsg.appendChild(p); });
    if (acao) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn-outline-navy'; b.textContent = acao.rotulo;
      b.addEventListener('click', acao.fn);
      docMsg.appendChild(b);
    }
    show(docMsg);
  }

  // Valida as duas coordenadas digitadas e atualiza o mini-mapa.
  function validarCoordenadasDoc() {
    coordDoc = null;
    const la = lerCoordenada(docLat.value, true);
    const lo = lerCoordenada(docLng.value, false);
    if (la.vazio && lo.vazio) { hide(docMsg); return; }
    const erros = [la.erro, lo.erro].filter(Boolean);
    if (la.vazio) erros.push('Digite a latitude.');
    if (lo.vazio) erros.push('Digite a longitude.');
    if (erros.length) { mensagemCoord('erro', erros); return; }

    const lat = la.valor, lng = lo.valor;
    // latitude e longitude invertidas (comum ao copiar de outras fontes)
    if (!dentroDePernambuco(lat, lng) && dentroDePernambuco(lng, lat)) {
      mensagemCoord('erro', ['Parece que a latitude e a longitude estão trocadas.'], {
        rotulo: 'Trocar', fn: function () { const t = docLat.value; docLat.value = docLng.value; docLng.value = t; validarCoordenadasDoc(); }
      });
      return;
    }
    if (la.ajustado) docLat.value = lat.toFixed(6);
    if (lo.ajustado) docLng.value = lng.toFixed(6);

    coordDoc = { lat: lat, lng: lng };
    const avisos = [];
    if (!dentroDePernambuco(lat, lng)) avisos.push('Este ponto fica fora de Pernambuco. Confira as coordenadas.');
    const perto = pontoProximo(lat, lng, 30);
    if (perto) avisos.push('Já existe "' + perto.ponto.nome + '" a ' + Math.round(perto.distancia) + ' m daqui. Confira se não é a mesma edificação.');
    if (avisos.length) mensagemCoord('alerta', avisos);
    else mensagemCoord('ok', ['Ponto marcado no mapa: confira se está sobre a edificação (use o modo Satélite).']);

    iniciarMapaDoc();
    if (marcadorDoc) marcadorDoc.setLatLng([lat, lng]);
    else marcadorDoc = L.marker([lat, lng]).addTo(mapaDoc);
    mapaDoc.setView([lat, lng], 18);
  }

  // Colar "-9.389123, -40.503456" (formato do Google Maps) em qualquer campo preenche os dois.
  function tratarColagemCoord() {
    const par = /^\s*(-?\d{1,3}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)\s*$/.exec(this.value);
    if (par) {
      docLat.value = Number(par[1]).toFixed(6);
      docLng.value = Number(par[2]).toFixed(6);
    }
  }
  [docLat, docLng].forEach(function (el) {
    el.addEventListener('input', tratarColagemCoord);
    el.addEventListener('change', validarCoordenadasDoc);
    el.addEventListener('blur', validarCoordenadasDoc);
  });

  function erroDocs(msg) { docErro.textContent = msg; show(docErro); }

  function conferirPdf(arquivo, rotulo) {
    if (!/\.pdf$/i.test(arquivo.name) && arquivo.type !== 'application/pdf') return 'O ' + rotulo + ' precisa ser um arquivo PDF.';
    if (arquivo.size > 5 * 1024 * 1024) return 'O ' + rotulo + ' tem mais de 5 MB. Envie um PDF menor.';
    return '';
  }

  btnLerDocs.addEventListener('click', function () {
    hide(docErro);
    const session = getSession();
    if (!session) { pedirLogin(); return; }
    const memorial = docMemorial.files[0];
    const avcb = docAvcb.files[0];
    if (!memorial) { erroDocs('Selecione o memorial descritivo (PDF).'); return; }
    const problema = conferirPdf(memorial, 'memorial descritivo') || (avcb ? conferirPdf(avcb, 'AVCB') : '');
    if (problema) { erroDocs(problema); return; }
    validarCoordenadasDoc();
    if (!coordDoc) { erroDocs('Digite a latitude e a longitude da edificação com 6 casas decimais.'); return; }

    btnLerDocs.disabled = true;
    btnLerDocs.textContent = 'Lendo os documentos… (pode levar até 1 minuto)';
    Promise.all([lerArquivoBase64(memorial), avcb ? lerArquivoBase64(avcb) : Promise.resolve(null)])
      .then(function (b) {
        const pedido = { token: session.token, memorial: { nome: memorial.name, base64: b[0] } };
        if (b[1]) pedido.avcb = { nome: avcb.name, base64: b[1] };
        const corpo = JSON.stringify(pedido);
        // Uma nova tentativa automática se a conexão cair (instabilidade momentânea da rede).
        const enviar = function (tentativa) {
          return fetch(LEITURA_DOCS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: corpo })
            .catch(function (err) {
              if (tentativa >= 2) throw err;
              return new Promise(function (ok) { setTimeout(ok, 2500); }).then(function () { return enviar(tentativa + 1); });
            });
        };
        return enviar(1).then(function (r) {
          return r.text().then(function (t) {
            try { return JSON.parse(t); } catch (e) { throw new Error('O serviço de leitura não respondeu agora (HTTP ' + r.status + '). Tente de novo ou use a aba "Preencher tudo".'); }
          });
        });
      })
      .then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.error) || 'Não foi possível ler os documentos.');
        preencherFormComLeitura(res);
      })
      .catch(function (err) {
        const msg = (err && err.message) || '';
        erroDocs(/failed to fetch|networkerror|load failed/i.test(msg)
          ? 'Sem conexão com o serviço de leitura. Verifique a internet e tente de novo, ou use a aba "Preencher tudo".'
          : (msg || 'Não foi possível ler os documentos agora.'));
      })
      .finally(function () { btnLerDocs.disabled = false; btnLerDocs.textContent = 'Ler documentos'; });
  });

  // Abre o formulário já preenchido com o que foi lido, para o militar conferir e salvar.
  function preencherFormComLeitura(res) {
    const d = res.dados || {};
    form.reset();
    document.getElementById('input-nome').value = d.nome || '';
    document.getElementById('input-capacidade').value = d.capacidade_litros !== '' && d.capacidade_litros != null ? d.capacidade_litros : '';
    document.getElementById('check-fachada').checked = d.hidrante_fachada === 'SIM';
    document.getElementById('check-recalque').checked = d.hidrante_recalque === 'SIM';
    document.getElementById('check-sprinkler').checked = d.possui_sprinkler === 'SIM';
    document.getElementById('check-caldeira').checked = d.possui_caldeira === 'SIM';
    checkAvcb.checked = d.possui_avcb === 'SIM';
    toggleCampoDataAvcb();
    inputDataAvcb.value = d.data_validade_avcb || '';
    document.getElementById('input-pavimentos').value = d.quantidade_pavimentos !== '' && d.quantidade_pavimentos != null ? d.quantidade_pavimentos : '';
    document.getElementById('input-area').value = d.area_construida !== '' && d.area_construida != null ? d.area_construida : '';
    document.getElementById('input-altura').value = d.altura_edificacao !== '' && d.altura_edificacao != null ? d.altura_edificacao : '';
    preencherEndereco({ rua: d.rua, numero: d.numero, bairro: d.bairro, cidade: d.cidade });

    currentCapture = { lat: coordDoc.lat, lng: coordDoc.lng };
    document.getElementById('loc-lat-doc').textContent = coordDoc.lat.toFixed(6);
    document.getElementById('loc-lng-doc').textContent = coordDoc.lng.toFixed(6);

    // Endereço que não veio nos documentos: completa pela coordenada (só os campos vazios).
    if (!d.rua || !d.numero || !d.bairro || !d.cidade) {
      const alvo = currentCapture;
      reverseGeocode(alvo.lat, alvo.lng, function (addr) {
        if (currentCapture !== alvo) return;
        if (!inputRua.value) inputRua.value = addr.rua || '';
        if (!inputBairro.value) inputBairro.value = addr.bairro || '';
        if (!inputCidade.value) inputCidade.value = addr.cidade || '';
        if (!inputNumero.value) inputNumero.value = addr.numero || 'NI';
      });
    }

    const avisos = (res.avisos || []).slice();
    if (res.uso && typeof res.uso.restantes_hoje === 'number' && res.uso.restantes_hoje <= 5) {
      avisos.push('Sua conta ainda pode fazer ' + res.uso.restantes_hoje + ' leitura(s) de documentos hoje.');
    }
    mostrarAvisos(['Confira os dados lidos dos documentos e clique em "Salvar cadastro".'].concat(avisos));
    leituraFeita = true;
    selecionarAba('documentos');
  }

  document.getElementById('btn-voltar-docs').addEventListener('click', function () {
    leituraFeita = false;
    mostrarAvisos([]);
    selecionarAba('documentos');
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

    limparCadastro(); // form.reset() + arquivos, coordenadas e avisos da aba Documentos
    hide(formError);

    editingId = pointToEdit ? pointToEdit.id : null;
    modalTitulo.textContent = editingId ? 'Editar ocupação' : 'Cadastrar ocupação';
    btnSalvar.textContent = editingId ? 'Salvar edição' : 'Salvar cadastro';

    show(overlay);

    if (editingId) {
      // Edição: sem abas, ponto ajustável no mapa (como antes).
      hide(cadAbas);
      preencherFormParaEdicao(pointToEdit);
      selecionarAba('mapa');
      // initMiniMap reseta o endereço via reverseGeocode assíncrono;
      // reaplica os valores originais depois.
      setTimeout(function () { preencherEndereco({ rua: pointToEdit.rua, numero: pointToEdit.numero, bairro: pointToEdit.bairro, cidade: pointToEdit.cidade }); }, 300);
    } else {
      // Cadastro novo: as 3 abas, para todos os perfis que cadastram.
      show(cadAbas);
      selecionarAba('documentos');
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
      docMemorial.files.length || docAvcb.files.length || docLat.value.trim() || docLng.value.trim() ||
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
      formError.textContent = locMode === 'mapa'
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

    // Coerência com o COSCIP. Pede confirmação em vez de bloquear, porque um
    // prédio irregular pode mesmo não ter a ligação. Toda RTI serve a um
    // sistema fixo, e todo sistema fixo tem registro de recalque ou hidrante de
    // fachada (arts. 100 e 101); hidrante e chuveiros automáticos sempre têm RTI (art. 57).
    const temFachada = document.getElementById('check-fachada').checked;
    const temRecalque = document.getElementById('check-recalque').checked;
    const temSprinkler = document.getElementById('check-sprinkler').checked;
    const rtiLitros = Number(capacidade);
    if (rtiLitros > 0 && !temFachada && !temRecalque && !window.confirm(
      'Este cadastro tem RTI de ' + rtiLitros.toLocaleString('pt-BR') + ' L, mas nenhum hidrante marcado.\n\n' +
      'Pelo COSCIP (arts. 100 e 101), toda edificação com RTI tem registro de recalque (na calçada) ' +
      'ou hidrante de fachada (na parede/muro).\n\n' +
      'Clique em OK para salvar assim mesmo, ou em Cancelar para marcar o hidrante.')) {
      document.getElementById('check-recalque').focus();
      return;
    }
    if ((temSprinkler || temFachada || temRecalque) && rtiLitros === 0 && !window.confirm(
      (temSprinkler ? 'Sprinklers marcados' : 'Hidrante marcado') + ', mas a RTI está em 0 L.\n\n' +
      'Pelo COSCIP (art. 57), todo sistema de hidrantes, mangotinhos ou chuveiros automáticos tem reserva técnica de incêndio.\n\n' +
      'Clique em OK para salvar assim mesmo, ou em Cancelar para informar a capacidade.')) {
      document.getElementById('input-capacidade').focus();
      return;
    }

    const record = {
      timestamp: new Date().toISOString(),
      lat: currentCapture.lat,
      lng: currentCapture.lng,
      nome: nome,
      capacidade_litros: rtiLitros,
      hidrante_fachada: temFachada ? 'SIM' : 'NAO',
      hidrante_recalque: temRecalque ? 'SIM' : 'NAO',
      possui_sprinkler: temSprinkler ? 'SIM' : 'NAO',
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
      cadastrado_por: session.login,
      // aba usada no cadastro (só vai para o LOG de auditoria no servidor)
      origem: editingId ? undefined : locMode
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
        pontosPorId[pontoFinal.id] = pontoFinal;
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
