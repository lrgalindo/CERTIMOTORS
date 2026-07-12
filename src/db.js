import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import { statusTrasFallo } from './queue.js';

// supabase-js usa fetch, que no tiene timeout: era el único cliente HTTP sin
// acotar tras el fix de axios (PR #11) y cada job hace varias llamadas a DB.
// Un fetch colgado dejaba el job en 'procesando' hasta que lo rescatara el reaper.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  global: {
    fetch: (url, options = {}) =>
      fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(Number(process.env.SUPABASE_TIMEOUT_MS) || 15000) }),
  },
});

export async function initDB() {
  try {
    const { error } = await supabase.from('clientes').select('id').limit(1);
    if (error) throw new Error(`Supabase connection failed: ${error.message}`);
    console.log('✅ Base de datos inicializada (Supabase PostgreSQL)');
    return supabase;
  } catch (err) {
    console.error('❌ Database initialization error:', err.message);
    throw err;
  }
}

export async function crearCliente(numero_telefono, data = {}) {
  const id = uuidv4();
  const { nombre = 'Cliente', tipo = 'CLIENTE' } = data;
  
  const { data: result, error } = await supabase
    .from('clientes')
    .insert([{ id, numero_telefono, nombre, tipo }])
    .select();
  
  if (error) throw new Error(`Error creating client: ${error.message}`);
  return result[0];
}

export async function obtenerClientePorNumero(numero_telefono) {
  const { data, error } = await supabase
    .from('clientes')
    .select('*')
    .eq('numero_telefono', numero_telefono)
    .single();
  
  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

export async function crearOrden(placa, data = {}) {
  const id = uuidv4();
  const { cliente_id, tipo_auto = 'RODADO', status = 'INICIADA' } = data;
  
  const { data: result, error } = await supabase
    .from('ordenes')
    .insert([{ id, placa, cliente_id, tipo_auto, status }])
    .select();
  
  if (error) throw new Error(`Error creating order: ${error.message}`);
  return result[0];
}

export async function obtenerOrdenPorPlaca(placa) {
  const { data, error } = await supabase
    .from('ordenes')
    .select('*')
    .eq('placa', placa)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

export async function actualizarStatusOrden(placa, status) {
  const { error } = await supabase
    .from('ordenes')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('placa', placa);

  if (error) throw new Error(`Error actualizando status de orden: ${error.message}`);
}

export async function obtenerClientePorId(id) {
  const { data, error } = await supabase
    .from('clientes')
    .select('*')
    .eq('id', id)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

// Última orden del cliente — recupera el contexto cuando el mensaje no trae
// placa (el caso normal: el cliente no repite la placa en cada mensaje).
export async function obtenerUltimaOrdenPorCliente(clienteId) {
  const { data, error } = await supabase
    .from('ordenes')
    .select('*')
    .eq('cliente_id', clienteId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) throw new Error(`Error obteniendo orden del cliente: ${error.message}`);
  return data?.[0] || null;
}

// Historial por cliente (no por placa): cubre la conversación pre-placa y
// mantiene el hilo aunque el cliente tenga más de una orden.
export async function obtenerConversacionesPorCliente(clienteId, limite = 6) {
  const { data, error } = await supabase
    .from('conversaciones')
    .select('*')
    .eq('cliente_id', clienteId)
    .order('created_at', { ascending: false })
    .limit(limite);

  if (error) throw new Error(`Error fetching client conversations: ${error.message}`);
  return data || [];
}

export async function guardarConversacion(placa, cliente_id, tipo_usuario, mensaje_entrada, respuesta_ia, tokens = 0) {
  const id = uuidv4();
  const { data: result, error } = await supabase
    .from('conversaciones')
    .insert([{ id, placa, cliente_id, tipo_usuario, mensaje_entrada, respuesta_ia, tokens_usados: tokens }])
    .select();

  if (error) throw new Error(`Error saving conversation: ${error.message}`);
  return result[0];
}

export async function guardarRevision(placa, mecanico_id, punto_actual, respuesta) {
  const id = uuidv4();
  const { data: result, error } = await supabase
    .from('revisiones')
    .insert([{ id, placa, mecanico_id, punto_actual, respuesta }])
    .select();

  if (error) throw new Error(`Error saving revision: ${error.message}`);
  return result[0];
}

export async function obtenerRevisionesPorPlaca(placa) {
  const { data, error } = await supabase
    .from('revisiones')
    .select('*')
    .eq('placa', placa)
    .order('punto_actual', { ascending: true });

  if (error) throw new Error(`Error fetching revisions: ${error.message}`);
  return data || [];
}

// Última placa en la que este mecánico registró un hallazgo — permite
// continuar una inspección en curso sin que repita la placa en cada mensaje.
export async function obtenerUltimaPlacaPorMecanico(mecanicoId) {
  const { data, error } = await supabase
    .from('revisiones')
    .select('placa')
    .eq('mecanico_id', String(mecanicoId))
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) throw new Error(`Error obteniendo última placa del mecánico: ${error.message}`);
  return data?.[0]?.placa || null;
}

export async function crearNotificacion(placa, tipo, mensaje) {
  const id = uuidv4();
  const { data: result, error } = await supabase
    .from('notificaciones')
    .insert([{ id, placa, tipo, mensaje }])
    .select();

  if (error) throw new Error(`Error creating notification: ${error.message}`);
  return result[0];
}

export async function actualizarDatosOrden(placa, datos) {
  const { error } = await supabase
    .from('ordenes')
    .update({ ...datos, updated_at: new Date().toISOString() })
    .eq('placa', placa);

  if (error) throw new Error(`Error actualizando datos de orden: ${error.message}`);
}

export async function guardarCertificado(placa, url) {
  const { error } = await supabase
    .from('ordenes')
    .update({ certificado_url: url, certificado_generado_at: new Date().toISOString() })
    .eq('placa', placa);

  if (error) throw new Error(`Error guardando certificado: ${error.message}`);
}

export async function obtenerNotificacionesPorPlacaYTipos(placa, tipos) {
  const { data, error } = await supabase
    .from('notificaciones')
    .select('*')
    .eq('placa', placa)
    .in('tipo', tipos)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Error fetching notifications by tipos: ${error.message}`);
  return data || [];
}

// Crea el bucket público "certificados" si no existe todavía. Idempotente:
// se puede llamar en cada arranque sin riesgo de duplicar el bucket.
export async function asegurarBucketCertificados() {
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw new Error(`Error listando buckets de Storage: ${error.message}`);

  const existe = (buckets || []).some((b) => b.name === 'certificados');
  if (existe) return;

  const { error: createError } = await supabase.storage.createBucket('certificados', { public: true });
  if (createError) throw new Error(`Error creando bucket certificados: ${createError.message}`);
}

export async function subirCertificado(nombreArchivo, buffer) {
  const { error } = await supabase.storage.from('certificados').upload(nombreArchivo, buffer, {
    contentType: 'application/pdf',
    upsert: true,
  });
  if (error) throw new Error(`Error subiendo certificado a Storage: ${error.message}`);

  const { data } = supabase.storage.from('certificados').getPublicUrl(nombreArchivo);
  return data.publicUrl;
}

export async function obtenerNotificacionesPorPlaca(placa) {
  const { data, error } = await supabase
    .from('notificaciones')
    .select('*')
    .eq('placa', placa)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) throw new Error(`Error fetching notifications by placa: ${error.message}`);
  return data || [];
}

export async function registrarCostoAPI({ rol, modelo, tipoTarea, tokensInput, tokensOutput, tokensCacheCreation = 0, tokensCacheRead = 0, costoUsd, placa = null }) {
  const id = uuidv4();
  const { data: result, error } = await supabase
    .from('costos_api')
    .insert([{
      id,
      rol,
      modelo,
      tipo_tarea: tipoTarea,
      tokens_input: tokensInput,
      tokens_output: tokensOutput,
      tokens_cache_creation: tokensCacheCreation,
      tokens_cache_read: tokensCacheRead,
      costo_estimado_usd: costoUsd,
      placa,
    }])
    .select();

  if (error) throw new Error(`Error logging API cost: ${error.message}`);
  return result[0];
}

export async function obtenerGastoDesde(fechaISO) {
  const { data, error } = await supabase
    .from('costos_api')
    .select('costo_estimado_usd, rol')
    .gte('created_at', fechaISO);

  if (error) throw new Error(`Error fetching spend: ${error.message}`);
  return data || [];
}

export async function obtenerEstadisticas() {
  const { count: clientesCount } = await supabase
    .from('clientes')
    .select('*', { count: 'exact', head: true });
  
  const { count: ordenesCount } = await supabase
    .from('ordenes')
    .select('*', { count: 'exact', head: true });
  
  const { count: conversacionesCount } = await supabase
    .from('conversaciones')
    .select('*', { count: 'exact', head: true });
  
  const { count: revisionesCount } = await supabase
    .from('revisiones')
    .select('*', { count: 'exact', head: true });
  
  return {
    clientes: clientesCount || 0,
    ordenes: ordenesCount || 0,
    conversaciones: conversacionesCount || 0,
    revisiones: revisionesCount || 0,
  };
}

export async function guardarTokenAprobacion(placa, token) {
  const { error } = await supabase
    .from('tokens_aprobacion')
    .insert([{ token, placa, usado: false }]);
  if (error) throw new Error(`Error guardando token de aprobación: ${error.message}`);
}

export async function obtenerPlacaPorToken(token) {
  const { data, error } = await supabase
    .from('tokens_aprobacion')
    .select('placa')
    .eq('token', token)
    .eq('usado', false)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data?.placa || null;
}

export async function marcarTokenUsado(token) {
  const { error } = await supabase
    .from('tokens_aprobacion')
    .update({ usado: true })
    .eq('token', token);
  if (error) throw new Error(`Error marcando token como usado: ${error.message}`);
}

export async function obtenerStatsReporte() {
  const hoyISO = new Date().toISOString().slice(0, 10);

  const [ordenesHoyRes, completadasHoyRes, estancadasRes, gastoHoyRes] = await Promise.all([
    supabase.from('ordenes').select('id', { count: 'exact', head: true }).gte('created_at', hoyISO),
    supabase
      .from('ordenes')
      .select('id', { count: 'exact', head: true })
      .in('status', ['INSPECCION_COMPLETA', 'TRAMITE_COMPLETO', 'CERTIFICADO_APROBADO'])
      .gte('updated_at', hoyISO),
    supabase
      .from('ordenes')
      .select('id', { count: 'exact', head: true })
      .not('status', 'in', '(INSPECCION_COMPLETA,TRAMITE_COMPLETO,CERTIFICADO_APROBADO)')
      .lte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    supabase.from('costos_api').select('costo_estimado_usd').gte('created_at', hoyISO),
  ]);

  const gastoHoy = (gastoHoyRes.data || []).reduce((sum, r) => sum + (r.costo_estimado_usd || 0), 0);

  return {
    ordenes_hoy: ordenesHoyRes.count || 0,
    completadas_hoy: completadasHoyRes.count || 0,
    leads_estancados_24h: estancadasRes.count || 0,
    gasto_dia_usd: Number(gastoHoy.toFixed(4)),
  };
}

// ─── Estado de conversación (máquina de estados WhatsApp) ────────────────────
// JSONB en clientes: las etapas 0-3 ocurren antes de que exista una orden.
// Requiere la migración 009.

export async function actualizarEstadoConversacion(clienteId, estado) {
  const { error } = await supabase
    .from('clientes')
    .update({ estado_conversacion: estado, updated_at: new Date().toISOString() })
    .eq('id', clienteId);
  if (error) throw new Error(`Error actualizando estado de conversación: ${error.message}`);
}

// ─── Fotos de inspección (bucket privado, separado de certificados) ──────────
// Requiere la migración 008 (tabla fotos_inspeccion). El bucket es privado:
// las fotos solo se leen desde el backend (service key) al generar el PDF.

export async function asegurarBucketFotos() {
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw new Error(`Error listando buckets de Storage: ${error.message}`);
  if ((buckets || []).some((b) => b.name === 'fotos-inspeccion')) return;
  const { error: createError } = await supabase.storage.createBucket('fotos-inspeccion', { public: false });
  if (createError) throw new Error(`Error creando bucket fotos-inspeccion: ${createError.message}`);
}

export async function subirFotoInspeccion(placa, buffer, contentType = 'image/jpeg') {
  const extension = contentType.split('/')[1] || 'jpg';
  const ruta = `${placa}/${uuidv4()}.${extension}`;
  const { error } = await supabase.storage.from('fotos-inspeccion').upload(ruta, buffer, { contentType });
  if (error) throw new Error(`Error subiendo foto de inspección: ${error.message}`);
  return ruta;
}

export async function guardarFotoInspeccion({ placa, punto = null, caption = null, storagePath }) {
  const { error } = await supabase
    .from('fotos_inspeccion')
    .insert([{ id: uuidv4(), placa, punto, caption, storage_path: storagePath }]);
  if (error) throw new Error(`Error guardando foto de inspección: ${error.message}`);
}

export async function obtenerFotosPorPlaca(placa) {
  const { data, error } = await supabase
    .from('fotos_inspeccion')
    .select('*')
    .eq('placa', placa)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Error obteniendo fotos de inspección: ${error.message}`);
  return data || [];
}

export async function descargarFoto(storagePath) {
  const { data, error } = await supabase.storage.from('fotos-inspeccion').download(storagePath);
  if (error) throw new Error(`Error descargando foto de inspección: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

// ─── Listados de solo lectura para el backoffice ─────────────────────────────

export async function listarOrdenes({ status = null, placa = null, limite = 50 } = {}) {
  let query = supabase.from('ordenes').select('*').order('created_at', { ascending: false }).limit(limite);
  if (status) query = query.eq('status', status);
  if (placa) query = query.eq('placa', placa);
  const { data, error } = await query;
  if (error) throw new Error(`Error listando órdenes: ${error.message}`);
  return data || [];
}

export async function listarJobs(limite = 50) {
  const { data, error } = await supabase
    .from('cola_jobs')
    .select('id, proveedor, status, intentos, max_intentos, error, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(limite);
  if (error) throw new Error(`Error listando jobs: ${error.message}`);
  return data || [];
}

export async function listarClientes(limite = 50) {
  const { data, error } = await supabase
    .from('clientes')
    .select('numero_telefono, nombre, created_at')
    .order('created_at', { ascending: false })
    .limit(limite);
  if (error) throw new Error(`Error listando clientes: ${error.message}`);
  return data || [];
}

export async function encolarJob(proveedor, externalId, payload) {
  const id = uuidv4();
  const { data: result, error } = await supabase
    .from('cola_jobs')
    .insert([{ id, proveedor, external_id: externalId, payload }])
    .select();

  if (error) {
    // Webhook retry con el mismo external_id: ya está encolado, no es un error.
    if (error.code === '23505') return null;
    throw new Error(`Error encolando job: ${error.message}`);
  }
  return result[0];
}

export async function reclamarJobsPendientes(limite) {
  const { data, error } = await supabase.rpc('reclamar_jobs_pendientes', { p_limite: limite });
  if (error) throw new Error(`Error reclamando jobs pendientes: ${error.message}`);
  return data || [];
}

export async function marcarJobCompletado(id) {
  const { error } = await supabase
    .from('cola_jobs')
    .update({ status: 'completado', updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw new Error(`Error marcando job completado: ${error.message}`);
}

// Jobs huérfanos: reclamados (status 'procesando') pero nunca resueltos —
// promesa colgada o proceso caído a mitad de trabajo. El reaper del worker
// los detecta por antigüedad de updated_at (el RPC de reclamo lo refresca).
export async function obtenerJobsHuerfanos(umbralMs) {
  const limite = new Date(Date.now() - umbralMs).toISOString();
  const { data, error } = await supabase
    .from('cola_jobs')
    .select('*')
    .eq('status', 'procesando')
    .lt('updated_at', limite);
  if (error) throw new Error(`Error buscando jobs huérfanos: ${error.message}`);
  return data || [];
}

export async function marcarJobFallido(id, { intentos, maxIntentos, error: errorMsg, proximoIntentoEn }) {
  const status = statusTrasFallo(intentos, maxIntentos);
  const { error } = await supabase
    .from('cola_jobs')
    .update({
      status,
      intentos,
      error: errorMsg,
      proximo_intento_en: proximoIntentoEn,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (error) throw new Error(`Error marcando job fallido: ${error.message}`);
}

export default {
  initDB,
  crearCliente,
  obtenerClientePorNumero,
  obtenerClientePorId,
  crearOrden,
  obtenerOrdenPorPlaca,
  actualizarStatusOrden,
  actualizarDatosOrden,
  guardarCertificado,
  obtenerUltimaOrdenPorCliente,
  obtenerConversacionesPorCliente,
  guardarConversacion,
  guardarRevision,
  obtenerRevisionesPorPlaca,
  obtenerUltimaPlacaPorMecanico,
  crearNotificacion,
  obtenerNotificacionesPorPlaca,
  obtenerNotificacionesPorPlacaYTipos,
  asegurarBucketCertificados,
  subirCertificado,
  registrarCostoAPI,
  obtenerGastoDesde,
  obtenerEstadisticas,
  guardarTokenAprobacion,
  obtenerPlacaPorToken,
  marcarTokenUsado,
  obtenerStatsReporte,
  actualizarEstadoConversacion,
  asegurarBucketFotos,
  subirFotoInspeccion,
  guardarFotoInspeccion,
  obtenerFotosPorPlaca,
  descargarFoto,
  listarOrdenes,
  listarJobs,
  listarClientes,
  encolarJob,
  reclamarJobsPendientes,
  marcarJobCompletado,
  marcarJobFallido,
  obtenerJobsHuerfanos,
};
