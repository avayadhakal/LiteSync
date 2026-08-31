from fastapi import APIRouter
from app.browse.routes import router as routes_router
from app.browse.download import router as download_router
from app.browse.upload import router as upload_router

router = APIRouter()
router.include_router(routes_router)
router.include_router(download_router)
router.include_router(upload_router)
