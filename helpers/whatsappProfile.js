import { defaultLogger } from './cloudWatchLogger.js'

export function extractProfilePictureJid(ctx) {
    return String(
        ctx?.key?.remoteJidAlt ||
        ctx?.key?.remoteJid ||
        (ctx?.from ? `${ctx.from}@s.whatsapp.net` : '')
    ).trim()
}

export async function getProfilePictureInfo(ctx, provider, { userId, numberPhone, name, file = 'whatsappProfile.js' } = {}) {
    const profilePictureJid = extractProfilePictureJid(ctx)

    if (!profilePictureJid) {
        return {
            profilePictureJid: '',
            profilePictureUrl: null
        }
    }

    try {
        const profilePictureUrl = await provider.vendor.profilePictureUrl(profilePictureJid, 'image')

        defaultLogger.info('Foto de perfil obtenida', {
            userId,
            numberPhone,
            name,
            profilePictureJid,
            profilePictureUrl,
            action: 'profile_picture_url',
            file
        })

        return {
            profilePictureJid,
            profilePictureUrl
        }
    } catch (error) {
        defaultLogger.warn('No se pudo obtener foto de perfil', {
            userId,
            numberPhone,
            name,
            profilePictureJid,
            error: error.message,
            action: 'profile_picture_error',
            file
        })

        return {
            profilePictureJid,
            profilePictureUrl: null
        }
    }
}
