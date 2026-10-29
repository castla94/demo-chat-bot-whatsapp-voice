// Importar función para obtener prompts de WhatsApp desde AWS
import { promptGetWhatsapp } from '../aws/index.js';
import { defaultLogger } from '../../helpers/cloudWatchLogger.js';



// Base de datos estática con el menú de productos y precios
const DATE_BASE = [
    `- Name: Cachapa,opciones(Carne Mechada,Cochino Frito),Price:10$`,
    `- Name: Sopa,opciones (sopa pollo,costilla y pescado),Price:7$`, 
    `- Name: Arepa,Opciones(arepa de queso amarrillo,pollo,carne mechada,pernil),Price:5$`,
    `- Name: Empanadas,Opciones(Empanadas de queso amarrillo,pollo,carne mechada,pernil),Price:5$`,
    `- Name: Bebidas,Opciones(Coca Cola,Naranja,Piña),Price:2.5$`,
    `- Name: Jugos Naturales,Opciones(Naranja,Mango,Durazno),Price:3$`,
].join('\n')

// Prompt para determinar el producto de interés del cliente
// Analiza la conversación y responde basado en productos disponibles
const PROMPT_DETERMINE = `
Analiza la conversación entre el cliente (C) y el vendedor (V) para identificar el producto de interés del cliente.

PRODUCTOS DISPONIBLES:
"{context}"

Debes responderle al cliente en base a lo que te indique, pero siempre respetando los productos disponibles , debes calcular totales 
dependiendo las cantidades solicitadas`

// Prompt de respaldo cuando no hay un prompt disponible en la base de datos.
const PROMPT = `
Responde siempre y únicamente con el siguiente mensaje, sin agregar ni modificar contenido:
Te atenderemos en unos momentos. LLAMANDO A UN ASESOR
`

/**
 * Genera un prompt personalizado para el cliente
 * @param {string} name - Nombre del cliente
 * @param {string} question - Pregunta o consulta del cliente
 * @param {string} phone - Número de teléfono del cliente
 * @returns {Promise<string>} Prompt personalizado
 */
export const generatePrompt = async (name,question,phone) => {
    const getWhatsappPrompt = await promptGetWhatsapp(question, phone);
    if(getWhatsappPrompt && getWhatsappPrompt.prompt){
        defaultLogger.info('Obteniendo prompt desde base de datos', {
            action: 'get_prompt_from_db',
            file: 'openai/prompt.js',
            prompt: getWhatsappPrompt.prompt
        });
        return getWhatsappPrompt.prompt.replaceAll('{customer_name}', name).replaceAll('{question}', question)
    }
    return PROMPT
}

/**
 * Genera el prompt para determinar el producto de interés
 * @returns {string} Prompt para determinar producto
 */
export const generatePromptDetermine = () => {
    return PROMPT_DETERMINE
}
