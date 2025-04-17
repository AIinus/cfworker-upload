/**
 * 平台路由模块，根据平台类型调用对应的上传函数
 */

import { uploadToYouTube } from './youtube.js';
import { uploadToBilibili } from './bilibili.js';

/**
 * 主上传函数，根据平台路由到对应的上传逻辑。
 * @param {string} platform - 目标平台
 * @param {ReadableStream} videoStream - 视频流
 * @param {Object} metadata - 视频元数据
 * @param {string} accessToken - 访问令牌
 * @param {Object} requestBody - 完整的请求体，包含各种封面路径参数
 * @param {string} [publish_time] - 发布时间 (可选)
 * @param {string} [YT_channelId] - YouTube 频道 ID (可选, 供参考)
 * @param {object} env - Cloudflare Worker 环境变量
 * @returns {Promise<Object>} - 上传结果
 */
export async function uploadToPlatform(platform, videoStream, metadata, accessToken, requestBody, publish_time, YT_channelId, env) {
  switch (platform.toLowerCase()) {
    case 'youtube':
      console.log(`准备上传到 YouTube 频道 (参考 ID: ${YT_channelId || '未提供'})`);
      return await uploadToYouTube(videoStream, metadata, accessToken, requestBody, publish_time, env);
    case 'bilibili':
      return await uploadToBilibili(videoStream, metadata, accessToken); // Bilibili 暂不支持新参数
    default:
      throw new Error(`不支持的平台: ${platform}`);
  }
}