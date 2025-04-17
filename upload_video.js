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

/**
 * 将视频上传到 YouTube，使用 YouTube Data API 的 videos.insert 端点。
 * @param {ReadableStream} videoStream - 从 R2 获取的视频数据流（ReadableStream 格式）
 * @param {Object} metadata - 视频元数据，包含 title、description 等字段
 * @param {string} accessToken - YouTube API 的访问令牌（从请求体中获取）
 * @returns {Promise<Object>} - 上传结果，返回 YouTube API 的响应
 */
async function uploadToYouTube(videoStream, metadata, accessToken) {
  // 定义 multipart 表单数据的边界字符串
  const boundary = '----CloudflareWorkerBoundary';
  
  // 创建 FormData 对象，用于构造 multipart/related 请求体
  const formData = new FormData();

  // 添加元数据部分，转换为 JSON 字符串并包装为 Blob
  const metadataPart = JSON.stringify({
    snippet: {
      title: metadata.title,
      description: metadata.description,
      tags: metadata.tags,
      categoryId: metadata.categoryId
    },
    status: {
      privacyStatus: metadata.privacyStatus || 'private'
    }
  });
  formData.append('metadata', new Blob([metadataPart], { type: 'application/json' }), 'metadata');

  // 添加视频数据部分，将视频流包装为 Blob
  formData.append('media', new Blob([videoStream], { type: 'video/mp4' }), 'video.mp4');

  // 发送请求到 YouTube API
  const response = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body: formData
  });

  // 检查响应是否成功
  if (!response.ok) {
    throw new Error(`YouTube API 错误: ${response.status} ${await response.text()}`);
  }

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
  throw new Error('Bilibili 上传功能尚未实现');
}

/**
 * 主上传函数，根据平台路由到对应的上传逻辑。
 * @param {string} platform - 目标平台（例如 "youtube", "bilibili"）
 * @param {ReadableStream} videoStream - 从 R2 获取的视频数据流
 * @param {Object} metadata - 视频元数据
 * @param {string} accessToken - 平台的访问令牌（从请求体中获取）
 * @returns {Promise<Object>} - 上传结果
 */
async function uploadToPlatform(platform, videoStream, metadata, accessToken) {
  switch (platform.toLowerCase()) {
    case 'youtube':
      return await uploadToYouTube(videoStream, metadata, accessToken);
    case 'bilibili':
      return await uploadToBilibili(videoStream, metadata, accessToken);
    default:
      throw new Error(`不支持的平台: ${platform}`);
  }
}

/**
 * Cloudflare Worker 的入口函数，处理所有请求。
 */
/**
 * 获取 YouTube 最新发布的视频信息
 * @param {string} accessToken - YouTube API 的访问令牌
 * @param {string} [channelId] - 可选的目标频道 ID。如果提供，则获取该频道的最新视频；否则获取认证用户的最新视频。
 * @returns {Promise<Object>} - 最新视频的信息
 */
async function getLatestYouTubeVideo(accessToken, channelId) {
  try {
    // 构建基础 URL 和参数
    const baseUrl = 'https://www.googleapis.com/youtube/v3/search';
    const params = new URLSearchParams({
      part: 'snippet',
      maxResults: '1',
      order: 'date',
      type: 'video'
    });

    // 根据是否提供了 channelId 添加参数
    if (channelId) {
      params.set('channelId', channelId);
    } else {
      params.set('forMine', 'true'); // 默认获取自己的视频
    }

    const apiUrl = `${baseUrl}?${params.toString()}`;

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    const responseText = await response.text();
    let responseData;
    
    try {
      responseData = JSON.parse(responseText);
    } catch (e) {
      throw new Error(`YouTube API 响应解析失败: ${responseText}`);
    }

    if (!response.ok) {
      throw new Error(`YouTube API 错误 (${response.status}): ${JSON.stringify(responseData)}`);
    }

    if (!responseData.items || responseData.items.length === 0) {
       // 根据是否有 channelId 提供更具体的错误信息
       const target = channelId ? `频道 ${channelId}` : '认证用户';
       throw new Error(`在 ${target} 未找到视频 (API 响应: ${JSON.stringify(responseData)})`);
    }

    const video = responseData.items[0];
    return {
      id: video.id.videoId,
      title: video.snippet.title,
      description: video.snippet.description,
      publishedAt: video.snippet.publishedAt,
      thumbnails: video.snippet.thumbnails
    };
  } catch (error) {
    // 重新抛出错误，但添加更多上下文信息
    throw new Error(`获取最新视频失败: ${error.message}`);
  }
}

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
      const { platform, videoPath, metadata } = body;


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

      // 调用上传函数，将视频上传到指定平台
      const result = await uploadToPlatform(platform, videoStream, metadata, accessToken);

      // 返回成功响应
      return new Response(JSON.stringify({
        success: true,
        platform: platform,
        videoId: result.id || 'N/A',
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