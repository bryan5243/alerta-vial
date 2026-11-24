// Archivo de arranque para cPanel ("Setup Node.js App" / Phusion Passenger).
// Passenger carga el archivo con require(); el servidor está escrito como módulo ES,
// así que lo importamos de forma dinámica. Passenger define process.env.PORT por su cuenta.
import('./server/index.js').catch(err => { console.error('No se pudo iniciar el Sistema de Alerta Vial:', err); process.exit(1); });
