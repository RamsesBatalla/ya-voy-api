import { supabase } from './db';

export async function setupSupabaseBuckets() {
  const buckets = [
    { id: 'platillos', public: true },
    { id: 'restaurantes', public: true },
    { id: 'verificacion-repartidor', public: false } // Private ephemeral bucket for driver identity verification
  ];

  for (const bucket of buckets) {
    try {
      const { data, error } = await supabase.storage.getBucket(bucket.id);
      if (error || !data) {
        console.log(`Creando bucket Supabase: ${bucket.id}...`);
        const { error: createError } = await supabase.storage.createBucket(bucket.id, {
          public: bucket.public,
          fileSizeLimit: 10485760 // 10MB
        });
        if (createError) {
          console.warn(`Aviso al crear bucket ${bucket.id}:`, createError.message);
        } else {
          console.log(`Bucket ${bucket.id} creado exitosamente.`);
        }
      } else {
        console.log(`Bucket ${bucket.id} ya existe.`);
      }
    } catch (err: any) {
      console.warn(`Error procesando bucket ${bucket.id}:`, err?.message || err);
    }
  }
}
