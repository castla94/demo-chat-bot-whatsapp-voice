const { addKeyword } = require('@bot-whatsapp/bot')
const { putWhatsapp,getWhatsapp,whatsappStatus } = require('../services/aws');

const menu = addKeyword(["Menu"])
.addAction(async (ctx, { flowDynamic, state,endFlow }) => {
    try{
        const name = ctx?.pushName ?? ''
        const numberPhone = ctx.from

        const getWhatsappStatus = await whatsappStatus();
        if(getWhatsappStatus && !getWhatsappStatus.status){
            console.log("Chat bot Disabled from database")
            return  endFlow();
        }

        const validateWhatsapp = await getWhatsapp(numberPhone)
        if(validateWhatsapp && !validateWhatsapp.status){
            console.log("Chat bot Session Disabled from database : "+numberPhone)
            return  endFlow();
        }

        await flowDynamic(name) 
        await flowDynamic([
            {
                body:'🍽️ Nuestro Menú 🍽️',
                media: 'https://res.cloudinary.com/dletveudc/image/upload/v1723064623/samples/logos/DALL_E_2024-08-07_17.01.05_-_A_visually_appealing_menu_showcasing_four_dishes_with_their_names_prices_and_options._The_menu_has_a_modern_design_with_a_clean_layout_and_vibrant_c_szhr8x.webp'
            }
        ]) 
        await flowDynamic("Quedo atento a tu pedido.") 
        await putWhatsapp(numberPhone,name,true)
    }catch(err){
        console.log(`[ERROR]:`,err)
    }
})

module.exports = { menu };
