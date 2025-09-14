const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Pool } = require('pg');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf');

const app = express();
const port = process.env.PORT || 3000;

// Configuración de base de datos PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuración de multer para archivos
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB máximo
  }
});

// Función principal de extracción de PDFs
function extraerDatosPDF(texto) {
  const extractores = [
    {
      nombre: "INS",
      detectar: (texto) => texto.includes("Instituto Nacional de Seguros") || texto.includes("grupoins.com"),
      extraer: (texto) => {
        const regex = /Costo Anual \(IVA\)\s*[₡¢]\s*([\d,]+\.?\d*)/;
        const match = texto.match(regex);
        return match ? {
          aseguradora: "INS",
          precio: parseFloat(match[1].replace(/,/g, '')),
          precioFormateado: "₡" + match[1],
          confianza: "alta"
        } : null;
      }
    },
    {
      nombre: "ASSA", 
      detectar: (texto) => texto.includes("ASSA") && texto.includes("Seguros"),
      extraer: (texto) => {
        const regexTabla = /Precio total\s*₡\s*([\d,]+\.?\d*)\s*₡\s*([\d,]+\.?\d*)\s*₡\s*([\d,]+\.?\d*)/;
        const match = texto.match(regexTabla);
        
        if (match) {
          const precios = [
            parseFloat(match[1].replace(/,/g, '')),
            parseFloat(match[2].replace(/,/g, '')), 
            parseFloat(match[3].replace(/,/g, ''))
          ];
          const precioMinimo = Math.min(...precios);
          
          return {
            aseguradora: "ASSA",
            planes: {
              platino: parseFloat(match[1].replace(/,/g, '')),
              dorado: parseFloat(match[2].replace(/,/g, '')),
              economico: parseFloat(match[3].replace(/,/g, ''))
            },
            precio: precioMinimo,
            precioFormateado: "₡" + precioMinimo.toLocaleString(),
            confianza: "alta"
          };
        }
        return null;
      }
    },
    {
      nombre: "MNK",
      detectar: (texto) => texto.includes("MNK") && texto.includes("SEGUROS"),
      extraer: (texto) => {
        const regex = /Anual\s*[₡¢]\s*([\d,]+\.?\d*)/;
        const match = texto.match(regex);
        return match ? {
          aseguradora: "MNK",
          precio: parseFloat(match[1].replace(/,/g, '')),
          precioFormateado: "₡" + match[1],
          confianza: "alta"
        } : null;
      }
    },
    {
      nombre: "QUALITAS",
      detectar: (texto) => texto.includes("Quálitas") || texto.includes("QUALITAS"),
      extraer: (texto) => {
        const regex = /IMPORTE TOTAL\s*[₡¢]\s*([\d,]+\.?\d*)/;
        const match = texto.match(regex);
        return match ? {
          aseguradora: "QUALITAS",
          precio: parseFloat(match[1].replace(/,/g, '')),
          precioFormateado: "₡" + match[1],
          confianza: "alta"
        } : null;
      }
    }
  ];
  
  for (let extractor of extractores) {
    if (extractor.detectar(texto)) {
      const resultado = extractor.extraer(texto);
      if (resultado) {
        return resultado;
      }
    }
  }
  
  return { 
    error: "Aseguradora no reconocida",
    confianza: "baja"
  };
}

// Función para extraer texto de PDF
async function extractTextFromPDF(buffer) {
  try {
    const data = new Uint8Array(buffer);
    const pdf = await pdfjsLib.getDocument(data).promise;
    
    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(item => item.str).join(' ');
      fullText += pageText + '\n';
    }
    return fullText;
  } catch (error) {
    console.error('Error extrayendo texto del PDF:', error);
    throw new Error('No se pudo leer el PDF');
  }
}

// RUTAS DE LA API

// Ruta para procesar PDF por cliente
app.post('/api/procesar-pdf/:cliente', upload.single('pdf'), async (req, res) => {
  try {
    const cliente = req.params.cliente;
    const pdfFile = req.file;
    
    if (!pdfFile) {
      return res.status(400).json({ error: 'No se envió ningún archivo PDF' });
    }

    // Extraer texto del PDF
    const textoCompleto = await extractTextFromPDF(pdfFile.buffer);
    
    // Procesar con nuestro extractor
    const resultado = extraerDatosPDF(textoCompleto);
    
    if (resultado.error) {
      return res.status(400).json(resultado);
    }

    // Obtener tenant_id
    const tenantQuery = await pool.query('SELECT id FROM tenants WHERE dominio = $1', [cliente]);
    
    if (tenantQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    
    const tenantId = tenantQuery.rows[0].id;

    // Guardar en base de datos
    const insertQuery = `
      INSERT INTO quotations (tenant_id, aseguradora, precio, vehiculo, fecha_cotizacion, datos_completos) 
      VALUES ($1, $2, $3, $4, CURRENT_DATE, $5) 
      RETURNING id
    `;
    
    const dbResult = await pool.query(insertQuery, [
      tenantId, 
      resultado.aseguradora, 
      resultado.precio, 
      'Pendiente extracción', // TODO: extraer datos del vehículo
      JSON.stringify(resultado)
    ]);

    res.json({
      ...resultado,
      id: dbResult.rows[0].id,
      cliente: cliente,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error procesando PDF:', error);
    res.status(500).json({ error: 'Error interno del servidor', detalle: error.message });
  }
});

// Ruta para obtener cotizaciones de un cliente
app.get('/api/cotizaciones/:cliente', async (req, res) => {
  try {
    const cliente = req.params.cliente;
    
    const query = `
      SELECT q.*, t.nombre as nombre_cliente 
      FROM quotations q 
      JOIN tenants t ON q.tenant_id = t.id 
      WHERE t.dominio = $1 
      ORDER BY q.fecha_cotizacion DESC, q.id DESC
    `;
    
    const result = await pool.query(query, [cliente]);
    res.json(result.rows);

  } catch (error) {
    console.error('Error obteniendo cotizaciones:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Ruta para crear nuevo cliente/tenant
app.post('/api/tenants', async (req, res) => {
  try {
    const { nombre, dominio, email } = req.body;
    
    const query = 'INSERT INTO tenants (nombre, dominio, email) VALUES ($1, $2, $3) RETURNING *';
    const result = await pool.query(query, [nombre, dominio, email]);
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creando tenant:', error);
    res.status(500).json({ error: 'Error creando cliente' });
  }
});

// Ruta para comparar precios
app.get('/api/comparacion/:cliente', async (req, res) => {
  try {
    const cliente = req.params.cliente;
    
    const query = `
      SELECT aseguradora, AVG(precio) as precio_promedio, COUNT(*) as total_cotizaciones
      FROM quotations q 
      JOIN tenants t ON q.tenant_id = t.id 
      WHERE t.dominio = $1 
      GROUP BY aseguradora 
      ORDER BY precio_promedio ASC
    `;
    
    const result = await pool.query(query, [cliente]);
    res.json(result.rows);

  } catch (error) {
    console.error('Error en comparación:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Ruta de salud
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Inicializar base de datos
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        dominio VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) NOT NULL,
        activo BOOLEAN DEFAULT true,
        plan VARCHAR(20) DEFAULT 'basico',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS quotations (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER REFERENCES tenants(id),
        aseguradora VARCHAR(50) NOT NULL,
        precio DECIMAL(12,2) NOT NULL,
        vehiculo VARCHAR(200),
        fecha_cotizacion DATE NOT NULL,
        datos_completos JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Base de datos inicializada correctamente');
  } catch (error) {
    console.error('Error inicializando base de datos:', error);
  }
}

// Iniciar servidor
app.listen(port, async () => {
  console.log(`Servidor corriendo en puerto ${port}`);
  await initDatabase();
});

module.exports = app;