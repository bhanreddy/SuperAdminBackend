const crypto = require('node:crypto');
const {sanitizeImage} = require('./learningContentImageProcessor');
const sql = require('../config/db');
const { schoolSupabaseAdmin: storage } = require('../config/supabase');
const { fail, id, text, keys } = require('./learningContentValidation');
const BUCKET = 'nexsyrus-content-private';
const MAX_BYTES = 5 * 1024 * 1024;

async function signUpload(body, actorId) {
  keys(body,['filename','mime_type','size'],'Image upload');
  const filename = text(body.filename,'Filename',255,true);
  if (!['image/jpeg','image/png','image/webp'].includes(body.mime_type)) fail('Choose a JPEG, PNG or WebP image');
  if (!Number.isSafeInteger(body.size) || body.size < 1 || body.size > MAX_BYTES) fail('Images must be no larger than 5 MB');
  const assetId = crypto.randomUUID();
  const storageKey = `platform/learning-library/${assetId}/source`;
  const {data,error} = await storage.storage.from(BUCKET).createSignedUploadUrl(storageKey);
  if (error) fail('Image storage is unavailable. Run the learning content migration and retry.',503);
  await sql`INSERT INTO content_assets(id,title,asset_type,mime_type,original_filename,storage_bucket,storage_key,status,visibility,file_size_bytes,metadata)
    VALUES(${assetId},${filename},'IMAGE',${body.mime_type},${filename},${BUCKET},${storageKey},'UPLOADING','INTERNAL',${body.size},${sql.json({origin:'superadmin-learning-library',actor_id:actorId})})`;
  return { asset_id:assetId, signed_url:data.signedUrl };
}
async function preview(assetId) {
  const [asset] = await sql`SELECT storage_bucket,storage_key FROM content_assets WHERE id=${assetId} AND school_id IS NULL AND asset_type='IMAGE' AND status IN ('READY','PUBLISHED') AND metadata->>'origin'='superadmin-learning-library'`;
  if (!asset) fail('Image not found or upload incomplete',404);
  const {data,error} = await storage.storage.from(asset.storage_bucket).createSignedUrl(asset.storage_key,3600);
  if (error) fail('Could not load this image. Try again.',503);
  return { asset_id:assetId,url:data.signedUrl };
}
async function confirmUpload(assetId,actorId) {
  id(assetId);
  const [asset] = await sql`SELECT storage_bucket,storage_key,status,file_size_bytes FROM content_assets WHERE id=${assetId} AND school_id IS NULL AND metadata->>'origin'='superadmin-learning-library' AND metadata->>'actor_id'=${actorId}`;
  if (!asset) fail('Image upload not found',404);
  if (asset.status === 'READY') return preview(assetId);
  if (asset.status !== 'UPLOADING') fail('Select and upload this image again',409);
  const {data,error} = await storage.storage.from(asset.storage_bucket).download(asset.storage_key);
  if (error) fail('Upload is incomplete. Retry the upload.',422);
  if (data.size > MAX_BYTES || data.size !== Number(asset.file_size_bytes)) fail('Uploaded image size does not match the selected file');
  const buffer = Buffer.from(await data.arrayBuffer());
  const output = await sanitizeImage(buffer);
  const key = `platform/learning-library/${assetId}/image.webp`;
  const uploaded = await storage.storage.from(asset.storage_bucket).upload(key,output.data,{contentType:'image/webp',upsert:true});
  if (uploaded.error) fail('Could not finish the image upload. Retry.',503);
  await sql`UPDATE content_assets SET storage_key=${key},mime_type='image/webp',status='READY',file_size_bytes=${output.data.length},width=${output.info.width},height=${output.info.height},checksum_sha256=${crypto.createHash('sha256').update(output.data).digest('hex')},updated_at=now() WHERE id=${assetId}`;
  await storage.storage.from(asset.storage_bucket).remove([asset.storage_key]);
  return preview(assetId);
}
module.exports = { signUpload,confirmUpload,preview,BUCKET,MAX_BYTES };
