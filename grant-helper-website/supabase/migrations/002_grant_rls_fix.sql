-- Fix: "new row violates row-level security policy" on INSERT into documents.
-- Use a SECURITY DEFINER function so the insert runs as the function owner (bypasses RLS)
-- while still enforcing auth.uid() = user_id inside the function.

-- Grant table usage and operations to Supabase API roles
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.documents TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_chunks TO anon, authenticated;

-- Function: insert document row only if auth.uid() matches (runs with definer rights, so RLS is bypassed)
CREATE OR REPLACE FUNCTION public.insert_document_for_user(
  p_user_id UUID,
  p_filename TEXT,
  p_mime_type TEXT,
  p_storage_path TEXT,
  p_file_size_bytes BIGINT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'Cannot insert document for another user';
  END IF;
  INSERT INTO public.documents (user_id, filename, mime_type, storage_path, file_size_bytes, status)
  VALUES (p_user_id, p_filename, p_mime_type, p_storage_path, p_file_size_bytes, 'uploaded')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.insert_document_for_user TO anon, authenticated;
