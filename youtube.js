/**
 * YouTube 相关功能模块
 */

/**
 * 格式化 YouTube API 访问令牌，确保它包含 Bearer 前缀
 * @param {string} accessToken - 原始访问令牌
 * @param {string} [operation='操作'] - 当前执行的操作名称，用于日志记录
 * @returns {string} - 格式化后的访问令牌
 */
function formatAccessToken(accessToken, operation = '操作') {
  const formattedAccessToken = accessToken.startsWith('Bearer ') ? accessToken : `Bearer ${accessToken}`;
  console.log(`准备${operation} YouTube，令牌前缀: ${formattedAccessToken.substring(0, 15)}...`);
  return formattedAccessToken;
}

/**
 * 将视频上传到 YouTube，使用 YouTube Data API 的 videos.insert 端点，并设置封面和发布时间。
 * @param {ReadableStream} videoStream - 从 R2 获取的视频数据流
 * @param {Object} metadata - 视频元数据
 * @param {string} accessToken - YouTube API 的访问令牌
 * @param {Object} requestBody - 完整的请求体，包含各种封面路径参数
 * @param {string} [publish_time] - ISO 8601 格式的计划发布时间 (可选)
 * @param {object} env - Cloudflare Worker 环境变量，包含 R2 绑定
 * @returns {Promise<Object>} - 上传结果，包含视频信息和封面上传状态
 */
export async function uploadToYouTube(videoStream, metadata, accessToken, requestBody, publish_time, env) {
  // --- 1. 上传视频元数据和内容 (videos.insert) ---
  const boundary = '----CloudflareWorkerBoundary' + Math.random().toString(16).substr(2);
  
  // 使用公共函数格式化 accessToken
  const formattedAccessToken = formatAccessToken(accessToken, '上传视频到');
  
  const videoMetadata = {
    snippet: {
      title: metadata.title,
      description: metadata.description,
      tags: metadata.tags,
      categoryId: metadata.categoryId
    },
    status: {
      // 如果设置了发布时间，强制设为 private，否则使用传入的值或默认 private
      privacyStatus: publish_time ? 'private' : (metadata.privacyStatus || 'private')
    }
  };

  // 如果有计划发布时间，添加到 status 对象
  if (publish_time) {
    // 检查时间格式，如果没有时区信息，自动添加 Z (UTC)
    let formattedTime = publish_time;
    if (!/Z|[+-]\d{2}:\d{2}$/.test(publish_time)) {
      formattedTime = `${publish_time}Z`;
      console.log(`发布时间未包含时区信息，已自动添加 Z (UTC): ${formattedTime}`);
    }
    
    try {
      // 验证是否为有效的 ISO 日期
      new Date(formattedTime).toISOString();
      videoMetadata.status.publishAt = formattedTime;
    } catch (e) {
      throw new Error(`无效的发布时间格式: ${publish_time}. 需要 ISO 8601 格式 (例如: 2025-04-17T23:57:16Z)`);
    }
  }

  // 手动构建 multipart 请求体
  const metadataJson = JSON.stringify(videoMetadata);
  
  // 创建一个数组缓冲区来存储视频数据
  const videoArrayBuffer = await new Response(videoStream).arrayBuffer();
  
  // 手动构建 multipart 请求体
  const multipartBody = new ReadableStream({
    async start(controller) {
      // 添加元数据部分
      const metadataPart = 
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${metadataJson}\r\n`;
      controller.enqueue(new TextEncoder().encode(metadataPart));
      
      // 添加视频部分
      const videoPart = 
        `--${boundary}\r\n` +
        `Content-Type: video/mp4\r\n\r\n`;
      controller.enqueue(new TextEncoder().encode(videoPart));
      
      // 添加视频数据
      controller.enqueue(new Uint8Array(videoArrayBuffer));
      
      // 添加结束边界
      controller.enqueue(new TextEncoder().encode(`\r\n--${boundary}--\r\n`));
      
      controller.close();
    }
  });

  const videoUploadResponse = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status', {
    method: 'POST',
    headers: {
      'Authorization': formattedAccessToken,  // 使用处理过的 accessToken
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body: multipartBody
  });

  if (!videoUploadResponse.ok) {
    throw new Error(`YouTube API 视频上传错误: ${videoUploadResponse.status} ${await videoUploadResponse.text()}`);
  }

  const videoResult = await videoUploadResponse.json();
  const videoId = videoResult.id;

  if (!videoId) {
    throw new Error(`视频上传成功，但未能获取 videoId: ${JSON.stringify(videoResult)}`);
  }

  // 添加：立即验证视频状态
  const verifyResponse = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=status&id=${videoId}`,
    {
      headers: {
        'Authorization': formattedAccessToken
      }
    }
  );

  const verifyResult = await verifyResponse.json();
  if (verifyResult.items[0]?.status?.privacyStatus !== 'private') {
    console.warn(`警告：视频隐私状态验证失败，期望 private 但获得 ${verifyResult.items[0]?.status?.privacyStatus}`);
  }

  // --- 2. 上传封面 (thumbnails.set)，如果提供了 coverPath 相关参数 ---
  let thumbnailUploadStatus = '未提供封面路径';
  
  // 尝试获取不同分辨率的封面路径
  const coverPathHigh = requestBody['coverPath-high'];
  const coverPathMedium = requestBody['coverPath-medium'];
  const coverPathDefault = requestBody['coverPath-default'] || requestBody['coverPath']; // 兼容旧参数名
  
  // 按优先级选择封面，确保值不为 null
  const selectedCoverPath = coverPathHigh || coverPathMedium || coverPathDefault;
  
  // 只有当 selectedCoverPath 存在且不为 null 时才尝试上传封面
  if (selectedCoverPath && selectedCoverPath !== null) {
    try {
      let thumbnailStream;
      let thumbnailContentType;
      let thumbnailSize;
      
      // 判断是否为URL
      if (selectedCoverPath.startsWith('http')) {
        console.log(`使用URL作为封面来源: ${selectedCoverPath}`);
        // 从URL获取图片
        const thumbnailResponse = await fetch(selectedCoverPath);
        if (!thumbnailResponse.ok) {
          throw new Error(`获取封面URL失败: ${thumbnailResponse.status} ${await thumbnailResponse.statusText}`);
        }
        
        thumbnailStream = thumbnailResponse.body;
        thumbnailContentType = thumbnailResponse.headers.get('Content-Type') || 'image/jpeg';
        const contentLength = thumbnailResponse.headers.get('Content-Length');
        thumbnailSize = contentLength ? parseInt(contentLength) : undefined;
      } else {
        console.log(`从R2获取封面: ${selectedCoverPath}`);
        // 从R2获取图片
        const thumbnailObject = await env.VIDEO_BUCKET.get(selectedCoverPath);
        if (!thumbnailObject) {
          throw new Error(`在R2中未找到封面文件: ${selectedCoverPath}`);
        }
        
        thumbnailStream = thumbnailObject.body;
        thumbnailContentType = thumbnailObject.httpMetadata?.contentType || 'image/jpeg';
        thumbnailSize = thumbnailObject.size;
      }
      
      // 准备上传封面的请求头
      const headers = {
        'Authorization': formattedAccessToken,  // 使用处理过的 accessToken
        'Content-Type': thumbnailContentType
      };
      
      // 如果有大小信息，添加到请求头
      if (thumbnailSize) {
        headers['Content-Length'] = thumbnailSize.toString();
      }

      // 上传封面到YouTube
      const thumbnailUploadResponse = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`, {
        method: 'POST',
        headers: headers,
        body: thumbnailStream
      });

      if (!thumbnailUploadResponse.ok) {
        thumbnailUploadStatus = `封面上传失败: ${thumbnailUploadResponse.status} ${await thumbnailUploadResponse.text()}`;
        console.error(`封面上传失败 for video ${videoId}: ${thumbnailUploadStatus}`);
      } else {
        thumbnailUploadStatus = `封面上传成功 (使用: ${selectedCoverPath})`;
      }
    } catch (thumbError) {
      thumbnailUploadStatus = `封面处理/上传时出错: ${thumbError.message}`;
      console.error(`封面处理/上传时出错 for video ${videoId}: ${thumbError.message}`);
    }
  } else {
    thumbnailUploadStatus = '未提供有效封面路径，将使用 YouTube 自动生成的封面';
    console.log(`视频 ${videoId} 将使用 YouTube 自动生成的封面`);
  }

  // 返回包含视频信息和封面状态的结果
  return {
      ...videoResult, // 包含原始的 video insert 结果 (id, snippet, status 等)
      thumbnailUploadStatus: thumbnailUploadStatus,
      // 添加 YouTube 自动生成的预设封面图 URL
      presetThumbnails: {
        default: `https://i.ytimg.com/vi/${videoId}/default.jpg`,
        medium: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        high: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        standard: `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`,
        maxres: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`
      }
  };
}

/**
 * 获取 YouTube 最新发布的视频信息
 * @param {string} accessToken - YouTube API 的访问令牌
 * @param {string} [channelId] - 可选的目标频道 ID。如果提供，则获取该频道的最新视频；否则获取认证用户的最新视频。
 * @returns {Promise<Object>} - 最新视频的信息
 */
export async function getLatestYouTubeVideo(accessToken, channelId) {
  try {
    // 使用公共函数格式化 accessToken
    const formattedAccessToken = formatAccessToken(accessToken, '获取最新视频从');
    
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
      console.log(`使用指定频道 ID: ${channelId}`);
    } else {
      params.set('forMine', 'true'); // 默认获取自己的视频
      console.log('使用 forMine=true 获取认证用户的视频');
    }

    const apiUrl = `${baseUrl}?${params.toString()}`;
    console.log(`发送请求到 YouTube API: ${apiUrl}`);

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Authorization': formattedAccessToken  // 使用处理过的 accessToken
      }
    });

    const responseText = await response.text();
    console.log(`YouTube API 响应状态码: ${response.status}`);
    
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch (e) {
      console.error(`解析响应失败: ${responseText}`);
      throw new Error(`YouTube API 响应解析失败: ${responseText}`);
    }

    if (!response.ok) {
      console.error(`API 错误: ${JSON.stringify(responseData)}`);
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

// 在文件末尾添加新函数

/**
 * 获取特定视频的详细信息
 * @param {string} accessToken - YouTube API 的访问令牌
 * @param {string} videoId - 要查询的视频 ID
 * @returns {Promise<Object>} - 视频详细信息
 */
export async function getVideoDetails(accessToken, videoId) {
  try {
    // 使用公共函数格式化 accessToken
    const formattedAccessToken = formatAccessToken(accessToken, '获取视频详情');
    
    // 构建 API URL
    const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,status,contentDetails,statistics&id=${videoId}`;
    console.log(`发送请求到 YouTube API: ${apiUrl}`);

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Authorization': formattedAccessToken
      }
    });

    const responseText = await response.text();
    console.log(`YouTube API 响应状态码: ${response.status}`);
    
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch (e) {
      console.error(`解析响应失败: ${responseText}`);
      throw new Error(`YouTube API 响应解析失败: ${responseText}`);
    }

    if (!response.ok) {
      console.error(`API 错误: ${JSON.stringify(responseData)}`);
      throw new Error(`YouTube API 错误 (${response.status}): ${JSON.stringify(responseData)}`);
    }

    if (!responseData.items || responseData.items.length === 0) {
      throw new Error(`未找到视频 ID: ${videoId}`);
    }

    // 返回完整的视频信息，包括频道 ID
    return responseData.items[0];
  } catch (error) {
    throw new Error(`获取视频详情失败: ${error.message}`);
  }
}