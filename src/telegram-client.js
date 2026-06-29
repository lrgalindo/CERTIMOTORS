import axios from 'axios';
import { logger } from './logger.js';

export async function enviarMensajeTelegram(botToken, chatId, texto) {
  if (!botToken) return;
  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text: texto,
      parse_mode: 'HTML',
    });
    logger.success(`Message sent to Telegram (${chatId})`);
  } catch (error) {
    logger.error('Error sending to Telegram', { error: error.message });
  }
}

// Returns the image as a base64 string, or null if unavailable.
// TELEGRAM_API_URL can be set in tests to point to a local fake server.
export async function obtenerImagenTelegram(botToken, fileId) {
  if (!botToken || !fileId) return null;
  const base = process.env.TELEGRAM_API_URL || 'https://api.telegram.org';
  try {
    const { data: fileInfo } = await axios.get(`${base}/bot${botToken}/getFile`, {
      params: { file_id: fileId },
    });
    if (!fileInfo.ok || !fileInfo.result?.file_path) return null;
    const { data } = await axios.get(`${base}/file/bot${botToken}/${fileInfo.result.file_path}`, {
      responseType: 'arraybuffer',
    });
    return Buffer.from(data).toString('base64');
  } catch {
    return null;
  }
}

export async function registrarWebhookTelegram(botToken, webhookUrl, nombre, secretToken = undefined) {
  if (!botToken) return;

  logger.info(`Registering ${nombre} Telegram webhook: ${webhookUrl}`);

  try {
    const response = await axios.post(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      url: webhookUrl,
      ...(secretToken ? { secret_token: secretToken } : {}),
    });

    if (response.data.ok) {
      logger.success(`${nombre} Telegram webhook registered`);
    } else {
      logger.error(`${nombre} webhook registration error`, { error: response.data.description });
    }
  } catch (error) {
    logger.error(`${nombre} Telegram setup error`, { error: error.message });
  }
}
