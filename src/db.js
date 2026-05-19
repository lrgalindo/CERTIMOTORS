import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';

const supabase = createClient(
  'https://iyijhruwsbyclavnoscy.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml5aWpocnV3c2J5Y2xhdm5vc2N5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyMTA0MjQsImV4cCI6MjA5NDc4NjQyNH0.tRPplcR0rq09o4xzSG4INX7eZUdVxhsb6TzvrxesL_s'
);

export async function initDB() {
  try {
    const { data, error } = await supabase.from('clientes').select('id').limit(1);
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
  const { error } = await supabase.from('clientes').insert([{ id, numero_telefono, nombre, tipo }]);
  if (error) throw new Error(`Failed to create client: ${error.message}`);
  return { id, numero_telefono, nombre, tipo };
}

export async function obtenerClientePorNumero(numero_telefono) {
  const { data, error } = await supabase.from('clientes').select('*').eq('numero_telefono', numero_telefono).single();
  if (error && error.code !== 'PGRST116') throw new Error(`Failed to fetch client: ${error.message}`);
  return data || null;
}

export async function crearOrden(placa, data = {}) {
  const id = uuidv4();
  const { cliente_id, tipo_auto = 'RODADO', status = 'INICIADA' } = data;
  const { error } = await supabase.from('ordenes').insert([{ id, placa, cliente_id, tipo_auto, status }]);
  if (error) throw new Error(`Failed to create order: ${error.message}`);
  return { id, placa, cliente_id, tipo_auto, status };
}

export async function obtenerOrdenPorPlaca(placa) {
  const { data, error } = await supabase.from('ordenes').select('*').eq('placa', placa).single();
  if (error && error.code !== 'PGRST116') throw new Error(`Failed to fetch order: ${error.message}`);
  return data || null;
}

export async function obtenerConversacionesPorPlaca(placa) {
  const { data, error } = await supabase.from('conversaciones').select('*').eq('placa', placa).order('created_at', { ascending: false }).limit(10);
  if (error) throw new Error(`Failed to fetch conversations: ${error.message}`);
  return data || [];
}

export async function guardarConversacion(placa, cliente_id, tipo_usuario, mensaje_entrada, respuesta_ia, tokens = 0) {
  const id = uuidv4();
  const { error } = await supabase.from('conversaciones').insert([{ id, placa, cliente_id, tipo_usuario, mensaje_entrada, respuesta_ia, tokens_usados: tokens }]);
  if (error) throw new Error(`Failed to save conversation: ${error.message}`);
  return { id, placa, tipo_usuario, mensaje_entrada, respuesta_ia };
}

export async function guardarRevision(placa, mecanico_id, punto_actual, respuesta) {
  const id = uuidv4();
  const { error } = await supabase.from('revisiones').insert([{ id, placa, mecanico_id, punto_actual, respuesta }]);
  if (error) throw new Error(`Failed to save revision: ${error.message}`);
  return { id, placa, punto_actual, respuesta };
}

export async function obtenerRevisionesPorPlaca(placa) {
  const { data, error } = await supabase.from('revisiones').select('*').eq('placa', placa).order('punto_actual', { ascending: true });
  if (error) throw new Error(`Failed to fetch revisions: ${error.message}`);
  return data || [];
}

export async function crearNotificacion(placa, tipo, mensaje) {
  const id = uuidv4();
  const { error } = await supabase.from('notificaciones').insert([{ id, placa, tipo, mensaje }]);
  if (error) throw new Error(`Failed to create notification: ${error.message}`);
  return { id, placa, tipo, mensaje };
}

export async function obtenerNotificacionesPendientes() {
  const { data, error } = await supabase.from('notificaciones').select('*').eq('enviado', false).order('created_at', { ascending: true });
  if (error) throw new Error(`Failed to fetch pending notifications: ${error.message}`);
  return data || [];
}

export async function marcarNotificacionEnviada(id) {
  const { error } = await supabase.from('notificaciones').update({ enviado: true }).eq('id', id);
  if (error) throw new Error(`Failed to mark notification as sent: ${error.message}`);
}

export async function obtenerEstadisticas() {
  try {
    const { data: estadisticas, error: estadError } = await supabase.from('estadisticas_diarias').select('*').order('fecha', { ascending: false }).limit(1);
    if (estadError) throw estadError;
    if (estadisticas && estadisticas.length > 0) {
      const stats = estadisticas[0];
      return { clientes: stats.total_clientes || 0, ordenes: stats.total_ordenes || 0, conversaciones: 0, revisiones: stats.total_puntos_inspeccionados || 0 };
    }
    const clientes = await supabase.from('clientes').select('COUNT(*)', { count: 'exact' });
    const ordenes = await supabase.from('ordenes').select('COUNT(*)', { count: 'exact' });
    const conversaciones = await supabase.from('conversaciones').select('COUNT(*)', { count: 'exact' });
    const revisiones = await supabase.from('revisiones').select('COUNT(*)', { count: 'exact' });
    return { clientes: clientes.count || 0, ordenes: ordenes.count || 0, conversaciones: conversaciones.count || 0, revisiones: revisiones.count || 0 };
  } catch (err) {
    console.error('Error fetching statistics:', err.message);
    return { clientes: 0, ordenes: 0, conversaciones: 0, revisiones: 0 };
  }
}

export default { initDB, crearCliente, obtenerClientePorNumero, crearOrden, obtenerOrdenPorPlaca, obtenerConversacionesPorPlaca, guardarConversacion, guardarRevision, obtenerRevisionesPorPlaca, crearNotificacion, obtenerNotificacionesPendientes, marcarNotificacionEnviada, obtenerEstadisticas };
