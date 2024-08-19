const { createBot, createProvider, createFlow, addKeyword,EVENTS } = require('@bot-whatsapp/bot')

const QRPortalWeb = require('@bot-whatsapp/portal')
const BaileysProvider = require('@bot-whatsapp/provider/baileys')
const MockAdapter = require('@bot-whatsapp/database/mock')
const {voice} = require('./flow/voice')
const {media} = require('./flow/media')
const {menu} = require('./flow/menu')
const {chatbot} = require('./flow/chatbot')
const {vendor} = require('./flow/vendor')
const {welcome} = require('./flow/welcome')

const main = async () => {
    const adapterDB = new MockAdapter()
    const adapterFlow = createFlow([voice,media,menu,chatbot,vendor,welcome])
    const adapterProvider = createProvider(BaileysProvider)

    createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    })

    QRPortalWeb()
}

main()


