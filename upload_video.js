/**
 * Cloudflare Worker 用于从 R2 存储桶将视频上传到 YouTube（未来可扩展到其他平台如 Bilibili）。
 * 
 * 环境变量说明：
 * - VIDEO_BUCKET: R2 存储桶的绑定名称（例如 my-bucket，用于直接访问 R2 中的文件）
 * - API_SECRET: 用于验证 n8n 请求的密钥（防止未经授权的访问）
 * 
 * n8n 请求格式（POST 请求）：
 * POST /
 * Headers:
 *   X-API-Secret: <api_secret> // 用于请求认证的密钥
 * Body: JSON
 * {
 *   "platform": "youtube", // 目标平台
 *   "videoPath": "video.mp4", // R2 中视频文件的路径
 *   "accessToken": "ya29.a0AfH6...", // YouTube API 的访问令牌（由 n8n 提供）
 *   "metadata": { // 视频元数据
 *     "title": "My Video",
 *     "description": "Uploaded via Cloudflare Worker",
 *     "tags": ["tag1", "tag2"],
 *     "categoryId": "22",
 *     "privacyStatus": "private"
 *   }
 * }
 */

import { uploadToPlatform } from './platforms.js';
import { getLatestYouTubeVideo } from './youtube.js';

export default {
  async fetch(request, env, ctx) {
    // 解析请求 URL
    const url = new URL(request.url);
    
    // 健康检查端点
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(JSON.stringify({
        status: 'healthy',
        timestamp: new Date().toISOString()
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 获取最新视频端点
    if (request.method === 'GET' && url.pathname === '/latest') {
      try {
        // 验证请求的 API 密钥
        const apiSecret = request.headers.get('X-API-Secret');
        if (!apiSecret || apiSecret !== env.API_SECRET) {
          return new Response('API 密钥无效或缺失', { status: 401 });
        }

        const accessToken = request.headers.get('Authorization')?.replace('Bearer ', '');
        if (!accessToken) {
          return new Response('缺少 Authorization 头或 accessToken', { status: 401 });
        }

        // 从 URL 查询参数获取 channelId (可选)
        const channelId = url.searchParams.get('channelId');

        // 调用函数，传入 accessToken 和可选的 channelId
        const latestVideo = await getLatestYouTubeVideo(accessToken, channelId); 
        
        return new Response(JSON.stringify(latestVideo), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('获取最新视频时出错:', error);
        return new Response(JSON.stringify({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // 原有的上传视频逻辑
    if (request.method !== 'POST') {
      return new Response('请求方法不支持，仅支持 GET 和 POST', { status: 405 });
    }
    
    try {
      // 验证请求的 API 密钥（通过请求头 X-API-Secret）
      const apiSecret = request.headers.get('X-API-Secret');
      if (!apiSecret || apiSecret !== env.API_SECRET) {
        return new Response('API 密钥无效或缺失', { status: 401 });
      }

      const accessToken = request.headers.get('Authorization')?.replace('Bearer ', '');
      if (!accessToken) {
        return new Response('缺少 Authorization 头或 accessToken', { status: 401 });
      }

      // 解析 n8n 发送的 JSON 请求体
      const body = await request.json();
      
      // 解构所有需要的参数
      const { platform, videoPath, metadata, publish_time, YT_channelId } = body;

      if (!platform || !videoPath || !metadata) {
        return new Response('缺少必需字段: platform, videoPath, metadata', { status: 400 });
      }

      // 验证元数据是否包含必要字段
      if (!metadata.title || !metadata.description) {
        return new Response('元数据必须包含 title 和 description', { status: 400 });
      }

      // 从 R2 存储桶获取视频文件
      const object = await env.VIDEO_BUCKET.get(videoPath);
      if (!object) {
        return new Response(`在 R2 中未找到视频文件: ${videoPath}`, { status: 404 });
      }
      const videoStream = object.body;

      // 调用上传函数，传递整个 body 对象而不是单独的 coverPath 参数
      const result = await uploadToPlatform(platform, videoStream, metadata, accessToken, body, publish_time, YT_channelId, env);

      // 返回成功响应，包含更丰富的信息
      return new Response(JSON.stringify({
        success: true,
        platform: platform,
        videoId: result.id || 'N/A',
        videoStatus: result.status, // 包含 privacyStatus, publishAt 等
        thumbnailStatus: result.thumbnailUploadStatus || 'N/A', // 封面上传状态
        message: `视频成功上传到 ${platform}` + (result.thumbnailUploadStatus ? ` (${result.thumbnailUploadStatus})` : '')
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      // 捕获所有错误，返回错误响应
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};