// =====================================================================
// Café Aroma — configuración pública de Supabase
// ---------------------------------------------------------------------
// Pega aquí los datos de tu proyecto (Supabase > Project Settings > API):
//   url     -> "Project URL"
//   anonKey -> "anon public" / "publishable" key
//
// Esta llave es PÚBLICA por diseño: solo permite lo que las políticas RLS
// autorizan (ver menú, crear pedidos, etc.). El inventario, los reportes y
// las funciones administrativas están protegidos en la base de datos.
//
// NUNCA pongas aquí la "service_role" / "secret" key.
// =====================================================================
window.CAFE_AROMA_CONFIG = {
  url: "https://ufihjuokkbojaflzuboh.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVmaWhqdW9ra2JvamFmbHp1Ym9oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA1NTA1MDQsImV4cCI6MjEwNjEyNjUwNH0.n-ooM3SteOCx-1xMcW6MpxqTVR1PpXmMXvStcuzH_YI"
};
