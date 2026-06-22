import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

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

export async function obtenerConversacionesPorPlaca(placa) {
  const { data, error } = await supabase
    .from('conversaciones')
    .select('*')
    .eq('placa', placa)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) throw new Error(`Error fetching conversations: ${error.message}`);
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

export async function crearNotificacion(placa, tipo, mensaje) {
  const id = uuidv4();
  const { data: result, error } = await supabase
    .from('notificaciones')
    .insert([{ id, placa, tipo, mensaje }])
    .select();

  if (error) throw new Error(`Error creating notification: ${error.message}`);
  return result[0];
}

export async function obtenerNotificacionesPendientes() {
  const { data, error } = await supabase
    .from('notificaciones')
    .select('*')
    .eq('enviado', false)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Error fetching pending notifications: ${error.message}`);
  return data || [];
}

export async function marcarNotificacionEnviada(id) {
  const { error } = await supabase.from('notificaciones').update({ enviado: true }).eq('id', id);
  if (error) throw new Error(`Error marking notification as sent: ${error.message}`);
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

export default {
  initDB,
  crearCliente,
  obtenerClientePorNumero,
  crearOrden,
  obtenerOrdenPorPlaca,
  obtenerConversacionesPorPlaca,
  guardarConversacion,
  guardarRevision,
  obtenerRevisionesPorPlaca,
  crearNotificacion,
  obtenerNotificacionesPendientes,
  marcarNotificacionEnviada,
  registrarCostoAPI,
  obtenerGastoDesde,
  obtenerEstadisticas,
};
