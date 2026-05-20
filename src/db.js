import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
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

export default { initDB, crearCliente, obtenerClientePorNumero, crearOrden, obtenerOrdenPorPlaca, obtenerEstadisticas };
