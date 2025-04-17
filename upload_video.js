/**
 * Cloudflare Worker 用于从 R2 存储桶将视频上传到 YouTube（未来可扩展到其他平台如 Bilibili）。
 * 
 * 环境变量说明：
 * - VIDEO_BUCKET: R2 存储桶的绑定名称（例如 my-bucket，用于直接访问 R2 中的文件）
 * - YOUTUBE_ACCESS_TOKEN: YouTube API 的访问令牌（通过 OAuth 2.0 获取，作用域需包含 https://www.googleapis.com/auth/youtube.upload）
 * 
 * n8n 请求格式（POST 请求）：
 * POST /
 * Body: JSON
 * {
 *   "platform": "youtube", // 目标平台，目前支持 "youtube"，未来可扩展到 "bilibili"
 *   "videoPath": "video.mp4", // R2 中视频文件的路径（相对于存储桶根目录）
 *   "metadata": { // 视频元数据
 *     "title": "My Video", // 视频标题
 *     "description": "Uploaded via Cloudflare Worker", // 视频描述
 *     "tags": ["tag1", "tag2"], // 标签数组
 *     "categoryId": "22", // YouTube 类别 ID（字符串，例如 "22" 表示 People & Blogs）
 *     "privacyStatus": "private" // 隐私状态（"public", "private", "unlisted"）
 *   }
 * }
 */

/**
 * 将视频上传到 YouTube，使用 YouTube Data API 的 videos.insert 端点。
 * @param {ReadableStream} videoStream - 从 R2 获取的视频数据流（ReadableStream 格式）
 * @param {Object} metadata - 视频元数据，包含 title、description 等字段
 * @param {string} accessToken - YouTube API 的访问令牌（用于认证）
 * @returns {Promise<Object>} - 上传结果，返回 YouTube API 的响应（包含视频 ID 等信息）
 */
async function uploadToYouTube(videoStream, metadata, accessToken) {
  // 定义 multipart 表单数据的边界字符串，用于分隔元数据和视频数据
  const boundary = '----CloudflareWorkerBoundary';
  
  // 创建 FormData 对象，用于构造 multipart/related 格式的请求体
  const formData = new FormData();

  // 添加元数据部分（metadata），转换为 JSON 字符串并包装为 Blob
  // YouTube API 要求元数据包含 snippet 和 status 两个部分
  const metadataPart = JSON.stringify({
    snippet: {
      title: metadata.title, // 视频标题
      description: metadata.description, // 视频描述
      tags: metadata.tags, // 标签数组
      categoryId: metadata.categoryId // 类别 ID（必须是字符串）
    },
    status: {
      privacyStatus: metadata.privacyStatus || 'private' // 隐私状态，默认值为 private
    }
  });
  // 将元数据作为 application/json 类型的 Blob 添加到 FormData 中，命名为 "metadata"
  formData.append('metadata', new Blob([metadataPart], { type: 'application/json' }), 'metadata');

  // 添加视频数据部分（media），将视频流包装为 Blob
  // 假设视频格式为 mp4，设置 MIME 类型为 video/mp4
  formData.append('media', new Blob([videoStream], { type: 'video/mp4' }), 'video.mp4');

  // 发送请求到 YouTube API 的 videos.insert 端点
  const response = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status', {
    method: 'POST', // 使用 POST 方法
    headers: {
      'Authorization': `Bearer ${accessToken}`, // 使用 Bearer 令牌进行认证
      'Content-Type': `multipart/related; boundary=${boundary}` // 设置 Content-Type 为 multipart/related
    },
    body: formData // 请求体为 FormData 对象，包含元数据和视频数据
  });

  // 检查 API 响应是否成功
  if (!response.ok) {
    // 如果失败，抛出错误并包含状态码和错误信息
    throw new Error(`YouTube API 错误: ${response.status} ${await response.text()}`);
  }

  // 返回 YouTube API 的响应（JSON 格式），包含新上传视频的 ID 等信息
  return await response.json();
}

/**
 * 占位函数，用于将视频上传到 Bilibili（待实现）。
 * @param {ReadableStream} videoStream - 从 R2 获取的视频数据流
 * @param {Object} metadata - 视频元数据
 * @param {string} accessToken - Bilibili API 的访问令牌
 * @returns {Promise<Object>} - 上传结果
 */
async function uploadToBilibili(videoStream, metadata, accessToken) {
  // TODO: 实现 Bilibili 的上传逻辑
  // 1. 调用 Bilibili 的 preupload API 获取上传授权
  // 2. 分片上传视频数据（支持大文件）
  // 3. 提交元数据（标题、描述、分区等）
  throw new Error('Bilibili 上传功能尚未实现');
}

/**
 * 主上传函数，根据平台路由到对应的上传逻辑。
 * @param {string} platform - 目标平台（例如 "youtube", "bilibili"）
 * @param {ReadableStream} videoStream - 从 R2 获取的视频数据流
 * @param {Object} metadata - 视频元数据
 * @param {Object} env - Worker 的环境变量（包含 API 凭据等）
 * @returns {Promise<Object>} - 上传结果
 */
async function uploadToPlatform(platform, videoStream, metadata, env) {
  // 根据平台名称（小写）选择对应的上传函数
  switch (platform.toLowerCase()) {
    case 'youtube':
      // 检查是否设置了 YouTube 的访问令牌
      if (!env.YOUTUBE_ACCESS_TOKEN) {
        throw new Error('环境变量 YOUTUBE_ACCESS_TOKEN 未设置');
      }
      // 调用 YouTube 上传函数
      return await uploadToYouTube(videoStream, metadata, env.YOUTUBE_ACCESS_TOKEN);
    case 'bilibili':
      // 检查是否设置了 Bilibili 的访问令牌
      if (!env.BILIBILI_ACCESS_TOKEN) {
        throw new Error('环境变量 BILIBILI_ACCESS_TOKEN 未设置');
      }
      // 调用 Bilibili 上传函数（待实现）
      return await uploadToBilibili(videoStream, metadata, env.BILIBILI_ACCESS_TOKEN);
    default:
      // 如果平台不支持，抛出错误
      throw new Error(`不支持的平台: ${platform}`);
  }
}

/**
 * Cloudflare Worker 的入口函数，处理所有请求。
 */
export default {
  async fetch(request, env, ctx) {
    // 仅处理 POST 请求（n8n 使用 POST 发送元数据）
    if (request.method !== 'POST') {
      return new Response('请求方法不支持，仅支持 POST', { status: 405 });
    }

    try {
      // 解析 n8n 发送的 JSON 请求体
      const body = await request.json();
      const { platform, videoPath, metadata } = body;

      // 验证请求体是否包含必需字段
      if (!platform || !videoPath || !metadata) {
        return new Response('缺少必需字段: platform, videoPath, metadata', { status: 400 });
      }

      // 验证元数据是否包含必要字段（标题和描述）
      if (!metadata.title || !metadata.description) {
        return new Response('元数据必须包含 title 和 description', { status: 400 });
      }

      // 从 R2 存储桶获取视频文件
      // env.VIDEO_BUCKET 是绑定的 R2 存储桶，直接通过 get 方法访问
      const object = await env.VIDEO_BUCKET.get(videoPath);
      if (!object) {
        return new Response(`在 R2 中未找到视频文件: ${videoPath}`, { status: 404 });
      }
      // 获取视频数据流（ReadableStream 格式）
      const videoStream = object.body;

      // 调用上传函数，将视频上传到指定平台
      const result = await uploadToPlatform(platform, videoStream, metadata, env);

      // 返回成功响应，包含上传结果
      return new Response(JSON.stringify({
        success: true,
        platform: platform,
        videoId: result.id || 'N/A', // YouTube 返回的视频 ID（如果有）
        message: `视频成功上传到 ${platform}`
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