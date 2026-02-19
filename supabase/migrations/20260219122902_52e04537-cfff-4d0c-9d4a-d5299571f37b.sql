
-- ============================================
-- 1. app_settings: только админы могут читать и обновлять
-- ============================================

-- Drop overly permissive policies
DROP POLICY IF EXISTS "Authenticated users can read settings" ON public.app_settings;
DROP POLICY IF EXISTS "Authenticated users can update settings" ON public.app_settings;

-- Only admins can read (contains API keys)
CREATE POLICY "Only admins can read settings"
  ON public.app_settings FOR SELECT
  USING (has_role(auth.uid(), 'admin'::app_role));

-- Only admins can update
CREATE POLICY "Only admins can update settings"
  ON public.app_settings FOR UPDATE
  USING (has_role(auth.uid(), 'admin'::app_role));

-- Editors can also read settings (needed for settings page)
CREATE POLICY "Editors can read settings"
  ON public.app_settings FOR SELECT
  USING (has_role(auth.uid(), 'editor'::app_role));

-- Editors can also update settings
CREATE POLICY "Editors can update settings"
  ON public.app_settings FOR UPDATE
  USING (has_role(auth.uid(), 'editor'::app_role));

-- ============================================
-- 2. knowledge_entries: INSERT/UPDATE/DELETE only for admin/editor
-- ============================================

-- Drop overly permissive policies
DROP POLICY IF EXISTS "Authenticated users can insert knowledge entries" ON public.knowledge_entries;
DROP POLICY IF EXISTS "Authenticated users can update knowledge entries" ON public.knowledge_entries;
DROP POLICY IF EXISTS "Authenticated users can delete knowledge entries" ON public.knowledge_entries;

-- Only admins and editors can insert
CREATE POLICY "Admins can insert knowledge entries"
  ON public.knowledge_entries FOR INSERT
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Editors can insert knowledge entries"
  ON public.knowledge_entries FOR INSERT
  WITH CHECK (has_role(auth.uid(), 'editor'::app_role));

-- Only admins and editors can update
CREATE POLICY "Admins can update knowledge entries"
  ON public.knowledge_entries FOR UPDATE
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Editors can update knowledge entries"
  ON public.knowledge_entries FOR UPDATE
  USING (has_role(auth.uid(), 'editor'::app_role));

-- Only admins and editors can delete
CREATE POLICY "Admins can delete knowledge entries"
  ON public.knowledge_entries FOR DELETE
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Editors can delete knowledge entries"
  ON public.knowledge_entries FOR DELETE
  USING (has_role(auth.uid(), 'editor'::app_role));

-- Keep public SELECT as-is (needed for chat-consultant edge function via service_role, and public read is intentional)
