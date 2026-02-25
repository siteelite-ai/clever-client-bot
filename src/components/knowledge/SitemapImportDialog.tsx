import { useState, useMemo, useCallback } from 'react';
import { Map, Search, Loader2, ChevronRight, ChevronDown, Globe, FolderOpen, FileText, Download } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

interface TreeNode {
  name: string;
  fullPath: string;
  url?: string;
  children: TreeNode[];
}

interface SitemapImportDialogProps {
  onImportComplete: () => void;
}

function buildTree(urls: string[]): TreeNode {
  const root: TreeNode = { name: '', fullPath: '', children: [] };

  for (const url of urls) {
    try {
      const parsed = new URL(url);
      const parts = [parsed.origin, ...parsed.pathname.split('/').filter(Boolean)];
      let current = root;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const fullPath = parts.slice(0, i + 1).join('/');
        let child = current.children.find(c => c.name === part);
        if (!child) {
          child = { name: part, fullPath, children: [] };
          current.children.push(child);
        }
        current = child;
      }
      current.url = url;
    } catch {
      // skip invalid URLs
    }
  }

  return root;
}

function getAllUrls(node: TreeNode): string[] {
  const urls: string[] = [];
  if (node.url) urls.push(node.url);
  for (const child of node.children) {
    urls.push(...getAllUrls(child));
  }
  return urls;
}

function TreeItem({
  node,
  selectedUrls,
  onToggle,
  searchQuery,
  depth = 0,
}: {
  node: TreeNode;
  selectedUrls: Set<string>;
  onToggle: (urls: string[], checked: boolean) => void;
  searchQuery: string;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(depth < 2);

  const nodeUrls = useMemo(() => getAllUrls(node), [node]);
  const matchesSearch = searchQuery
    ? nodeUrls.some(u => u.toLowerCase().includes(searchQuery.toLowerCase()))
    : true;

  if (!matchesSearch) return null;

  const allSelected = nodeUrls.length > 0 && nodeUrls.every(u => selectedUrls.has(u));
  const someSelected = nodeUrls.some(u => selectedUrls.has(u));
  const hasChildren = node.children.length > 0;
  const isLeaf = node.url && !hasChildren;

  const handleCheck = (checked: boolean) => {
    onToggle(nodeUrls, checked);
  };

  return (
    <div>
      <div
        className="flex items-center gap-1.5 py-1 px-1 rounded hover:bg-accent/50 cursor-pointer group"
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        {hasChildren ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-5 h-5 flex items-center justify-center text-muted-foreground hover:text-foreground shrink-0"
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        ) : (
          <span className="w-5" />
        )}

        <Checkbox
          checked={allSelected ? true : someSelected ? 'indeterminate' : false}
          onCheckedChange={handleCheck}
          className="shrink-0"
        />

        {depth === 0 ? (
          <Globe className="w-4 h-4 text-primary shrink-0" />
        ) : isLeaf ? (
          <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
        ) : (
          <FolderOpen className="w-4 h-4 text-amber-500 shrink-0" />
        )}

        <span
          className="text-sm truncate"
          title={node.url || node.name}
          onClick={() => hasChildren && setExpanded(!expanded)}
        >
          {depth === 0 ? node.name : decodeURIComponent(node.name)}
        </span>
      </div>

      {expanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <TreeItem
              key={child.fullPath}
              node={child}
              selectedUrls={selectedUrls}
              onToggle={onToggle}
              searchQuery={searchQuery}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SitemapImportDialog({ onImportComplete }: SitemapImportDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [sitemapUrl, setSitemapUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [urls, setUrls] = useState<string[]>([]);
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0 });

  const tree = useMemo(() => buildTree(urls), [urls]);

  const filteredCount = useMemo(() => {
    if (!searchQuery) return urls.length;
    return urls.filter(u => u.toLowerCase().includes(searchQuery.toLowerCase())).length;
  }, [urls, searchQuery]);

  const handleFetchSitemap = async () => {
    if (!sitemapUrl.trim()) return;

    setIsLoading(true);
    setUrls([]);
    setSelectedUrls(new Set());

    try {
      const { data, error } = await supabase.functions.invoke('knowledge-process', {
        body: {
          action: 'fetch_sitemap',
          url: sitemapUrl.trim(),
        },
      });

      if (error) throw error;
      if (!data.success) throw new Error(data.error);

      const fetchedUrls: string[] = data.urls || [];
      setUrls(fetchedUrls);

      if (fetchedUrls.length === 0) {
        toast.info('Sitemap не содержит URL-адресов');
      } else {
        toast.success(`Найдено ${fetchedUrls.length} страниц`);
      }
    } catch (error) {
      console.error('Error fetching sitemap:', error);
      toast.error(error instanceof Error ? error.message : 'Ошибка загрузки sitemap');
    } finally {
      setIsLoading(false);
    }
  };

  const handleToggle = useCallback((toggleUrls: string[], checked: boolean) => {
    setSelectedUrls(prev => {
      const next = new Set(prev);
      for (const u of toggleUrls) {
        if (checked) next.add(u);
        else next.delete(u);
      }
      return next;
    });
  }, []);

  const handleSelectAll = () => {
    setSelectedUrls(new Set(urls));
  };

  const handleDeselectAll = () => {
    setSelectedUrls(new Set());
  };

  const handleImport = async () => {
    const selected = Array.from(selectedUrls);
    if (selected.length === 0) return;

    setIsImporting(true);
    setImportProgress({ current: 0, total: selected.length });

    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < selected.length; i++) {
      setImportProgress({ current: i + 1, total: selected.length });
      try {
        const { data, error } = await supabase.functions.invoke('knowledge-process', {
          body: {
            action: 'scrape_url',
            url: selected[i],
          },
        });

        if (error || !data?.success) {
          errorCount++;
        } else {
          successCount++;
        }
      } catch {
        errorCount++;
      }
    }

    setIsImporting(false);

    if (successCount > 0) {
      toast.success(`Импортировано ${successCount} страниц${errorCount > 0 ? `, ошибок: ${errorCount}` : ''}`);
      onImportComplete();
      setIsOpen(false);
      setUrls([]);
      setSelectedUrls(new Set());
      setSitemapUrl('');
    } else {
      toast.error('Не удалось импортировать ни одной страницы');
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Map className="w-4 h-4 mr-2" />
          Sitemap XML
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Импорт из Sitemap XML</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 flex-1 min-h-0 flex flex-col">
          {/* URL input */}
          <div className="flex gap-2">
            <Input
              placeholder="https://220volt.kz/sitemap.xml"
              value={sitemapUrl}
              onChange={(e) => setSitemapUrl(e.target.value)}
              disabled={isLoading || isImporting}
              onKeyDown={(e) => e.key === 'Enter' && handleFetchSitemap()}
            />
            <Button
              onClick={handleFetchSitemap}
              disabled={isLoading || isImporting || !sitemapUrl.trim()}
              className="shrink-0"
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
            </Button>
          </div>

          {urls.length > 0 && (
            <>
              {/* Stats & search */}
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-sm text-muted-foreground">
                  Страниц: <strong className="text-foreground">{urls.length}</strong>
                  {selectedUrls.size > 0 && (
                    <> · Выбрано: <strong className="text-primary">{selectedUrls.size}</strong></>
                  )}
                  {searchQuery && (
                    <> · Найдено: <strong>{filteredCount}</strong></>
                  )}
                </span>
                <div className="flex gap-1 ml-auto">
                  <Button variant="ghost" size="sm" onClick={handleSelectAll} disabled={isImporting}>
                    Выбрать все
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleDeselectAll} disabled={isImporting}>
                    Снять все
                  </Button>
                </div>
              </div>

              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Поиск по URL..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                  disabled={isImporting}
                />
              </div>

              {/* Tree */}
              <ScrollArea className="flex-1 min-h-0 border rounded-lg" style={{ maxHeight: '400px' }}>
                <div className="p-2">
                  {tree.children.map((node) => (
                    <TreeItem
                      key={node.fullPath}
                      node={node}
                      selectedUrls={selectedUrls}
                      onToggle={handleToggle}
                      searchQuery={searchQuery}
                    />
                  ))}
                </div>
              </ScrollArea>

              {/* Import button */}
              <Button
                onClick={handleImport}
                disabled={isImporting || selectedUrls.size === 0}
                className="w-full"
              >
                {isImporting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Импорт {importProgress.current}/{importProgress.total}...
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4 mr-2" />
                    Импортировать {selectedUrls.size} {selectedUrls.size === 1 ? 'страницу' : selectedUrls.size < 5 ? 'страницы' : 'страниц'}
                  </>
                )}
              </Button>
            </>
          )}

          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-primary mr-2" />
              <span className="text-sm text-muted-foreground">Загрузка sitemap...</span>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
