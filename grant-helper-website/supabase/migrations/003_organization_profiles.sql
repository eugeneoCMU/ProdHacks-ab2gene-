-- -- Organization profile per authenticated user (nonprofit context)

-- CREATE TABLE public.organization_profiles (
--     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--     user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
--     organization_name TEXT NOT NULL,
--     organization_profile TEXT NOT NULL DEFAULT '',
--     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
--     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
-- );

-- CREATE INDEX idx_organization_profiles_user_id ON public.organization_profiles(user_id);

-- ALTER TABLE public.organization_profiles ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY "Users can view own organization profile"
--     ON public.organization_profiles FOR SELECT
--     USING (auth.uid() = user_id);

-- CREATE POLICY "Users can insert own organization profile"
--     ON public.organization_profiles FOR INSERT
--     WITH CHECK (auth.uid() = user_id);

-- CREATE POLICY "Users can update own organization profile"
--     ON public.organization_profiles FOR UPDATE
--     USING (auth.uid() = user_id);

-- GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_profiles TO anon, authenticated;

-- CREATE TRIGGER update_organization_profiles_updated_at
--     BEFORE UPDATE ON public.organization_profiles
--     FOR EACH ROW
--     EXECUTE FUNCTION public.update_updated_at_column();

-- -- When a user signs up, create their organization row from signup metadata (works with email confirmation)
-- CREATE OR REPLACE FUNCTION public.handle_new_user_organization()
-- RETURNS TRIGGER
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path = public
-- AS $$
-- BEGIN
--     INSERT INTO public.organization_profiles (user_id, organization_name, organization_profile)
--     VALUES (
--         NEW.id,
--         COALESCE(NULLIF(TRIM(NEW.raw_user_meta_data->>'organization_name'), ''), 'My organization'),
--         ''
--     );
--     RETURN NEW;
-- END;
-- $$;

-- CREATE TRIGGER on_auth_user_created_organization
--     AFTER INSERT ON auth.users
--     FOR EACH ROW
--     EXECUTE FUNCTION public.handle_new_user_organization();
