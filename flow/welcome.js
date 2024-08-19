const { addKeyword } = require('@bot-whatsapp/bot')

const welcome =  addKeyword(["buenas","hola","como esta"])
.addAction(async (ctx, { flowDynamic }) => {
    try{
        await flowDynamic([
            {
                body:'¡Bienvenido a nuestro Restaurante! 🌟\n\n'+
                'Estamos encantados de atenderte. ¿En qué podemos ayudarte hoy?'+
                '\n\n📋 Para ver el menú, escribe: *Menu*\n\n'+
                '🧑‍💼Para hablar con un vendedor, escribe: *Vendedor*',
            }
        ]) 
    }catch(err){
        console.log(`[ERROR]:`,err)
    }
})

module.exports = { welcome };
