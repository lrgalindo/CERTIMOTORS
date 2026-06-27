// Crea (si no existe) el bucket público "certificados" en Supabase Storage,
// donde se guardan los PDFs generados por generarCertificado().
// Uso: SUPABASE_URL=... SUPABASE_KEY=... node scripts/crear-bucket-certificados.js
import { asegurarBucketCertificados } from '../src/db.js';

await asegurarBucketCertificados();
console.log('✅ Bucket "certificados" listo.');
